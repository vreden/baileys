import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { randomBytes } from 'crypto';
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageAddressingMode } from '../Types/index.js';
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, delay, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageIDV2, generateParticipantHashV2, generateWAMessage, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, MessageRetryManager, normalizeMessageContent, parseAndInjectE2ESessions, unixTimestampSeconds, generateWAMessageFromContent } from '../Utils/index.js';
import { getUrlInfo } from '../Utils/link-preview.js';
import { makeKeyedMutex } from '../Utils/make-mutex.js';
import { areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, getBinaryFilteredButtons, isJidGroup, isPnUser, isJidNewsletter, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET, STORIES_JID } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { makeNewsletterSocket } from './newsletter.js';
export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: axiosOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
    const sock = makeNewsletterSocket(config);
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral } = sock;
    const userDevicesCache = config.userDevicesCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null;
    const encryptionMutex = makeKeyedMutex();
    let mediaConn;

    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: S_WHATSAPP_NET
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
                const node = {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            })();
        }
        return mediaConn;
    };

    const getMetadata = async (jid) => {
        if (!global.groupMetadataCache.has(jid)) {
            global.groupMetadataCache.set(jid, global.groupMetadata(jid))
        }
        return await global.groupMetadataCache.get(jid)
    }

    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds || messageIds.length === 0) {
            throw new Boom('missing ids in receipt');
        }
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = unixTimestampSeconds().toString();
        }
        if (type === 'sender' && isPnUser(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };

    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };

    const deduplicateLidPnJids = (jids) => {
        const lidUsers = new Set();
        const filteredJids = [];
        for (const jid of jids) {
            if (jid.includes('@lid')) {
                const user = jidDecode(jid)?.user;
                if (user)
                    lidUsers.add(user);
            }
        }
        for (const jid of jids) {
            if (jid.includes('@s.whatsapp.net')) {
                const user = jidDecode(jid)?.user;
                if (user && lidUsers.has(user)) {
                    logger.debug({ jid }, 'Skipping PN - LID version exists');
                    continue;
                }
            }
            filteredJids.push(jid);
        }
        return filteredJids;
    };

    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            logger.debug('not using cache for devices');
        }
        const toFetch = [];
        jids = deduplicateLidPnJids(Array.from(new Set(jids)));
        const jidsWithUser = jids.map(jid => {
            const decoded = jidDecode(jid);
            const user = decoded?.user;
            const device = decoded?.device;
            const isExplicitDevice = typeof device === 'number' && device >= 0;
            if (isExplicitDevice && user) {
                deviceResults.push({
                    user,
                    device,
                    wireJid: jid
                });
                return null;
            }
            jid = jidNormalizedUser(jid);
            return { jid, user };
        }).filter(jid => jid !== null);
        let mgetDevices;
        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean);
            mgetDevices = await userDevicesCache.mget(usersToFetch);
        }
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] ||
                    (userDevicesCache.mget ? undefined : (await userDevicesCache.get(user)));
                if (devices) {
                    const isLidJid = jid.includes('@lid');
                    const devicesWithWire = devices.map(d => ({
                        ...d,
                        wireJid: isLidJid ? jidEncode(d.user, 'lid', d.device) : jidEncode(d.user, 's.whatsapp.net', d.device)
                    }));
                    deviceResults.push(...devicesWithWire);
                    logger.trace({ user }, 'using cache for devices');
                }
                else {
                    toFetch.push(jid);
                }
            }
            else {
                toFetch.push(jid);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const requestedLidUsers = new Set();
        for (const jid of toFetch) {
            if (jid.includes('@lid')) {
                const user = jidDecode(jid)?.user;
                if (user) requestedLidUsers.add(user);
            }
        }
        const query = new USyncQuery().withContext('message').withDeviceProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid));
        }
        const result = await sock.executeUSyncQuery(query);
        if (result) {
            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
            }
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user);
                for (const item of userDevices) {
                    const finalWireJid = isLidUser ? jidEncode(user, 'lid', item.device) : jidEncode(item.user, 's.whatsapp.net', item.device);
                    deviceResults.push({
                        ...item,
                        wireJid: finalWireJid
                    });
                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalWireJid,
                        usedLid: isLidUser
                    }, 'Processed device with LID priority');
                }
            }
            if (userDevicesCache.mset) {
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })));
            }
            else {
                for (const key in deviceMap) {
                    if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key]);
                }
            }
        }
        return deviceResults;
    };

    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const jidsRequiringFetch = [];
        jids = deduplicateLidPnJids(jids);
        if (force) {
            const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid));
            const sessions = await authState.keys.get('session', addrs);
            const checkJidSession = (jid) => {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                const hasSession = !!sessions[signalId];
                if (!hasSession) {
                    if (jid.includes('@lid')) {
                        logger.debug({ jid }, 'No LID session found, will create new LID session');
                    }
                    jidsRequiringFetch.push(jid);
                }
            };
            for (const jid of jids) {
                checkJidSession(jid);
            }
        } else {
            const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid));
            const sessions = await authState.keys.get('session', addrs);
            const userGroups = new Map();
            for (const jid of jids) {
                const user = jidNormalizedUser(jid);
                if (!userGroups.has(user)) {
                    userGroups.set(user, []);
                }
                userGroups.get(user).push(jid);
            }
            const checkUserLidMapping = async (user, userJids) => {
                if (!userJids.some(jid => jid.includes('@s.whatsapp.net'))) {
                    return { shouldMigrate: false, lidForPN: undefined };
                }
                try {
                    const pnJid = `${user}@s.whatsapp.net`;
                    const mapping = await signalRepository.lidMapping.getLIDForPN(pnJid);
                    if (mapping?.includes('@lid')) {
                        logger.debug({ user, lidForPN: mapping, deviceCount: userJids.length }, 'User has LID mapping - preparing bulk migration');
                        return { shouldMigrate: true, lidForPN: mapping };
                    }
                }
                catch (error) {
                    logger.debug({ user, error }, 'Failed to check LID mapping for user');
                }
                return { shouldMigrate: false, lidForPN: undefined };
            };
            for (const [user, userJids] of userGroups) {
                const mappingResult = await checkUserLidMapping(user, userJids);
                const shouldMigrateUser = mappingResult.shouldMigrate;
                const lidForPN = mappingResult.lidForPN;
                if (shouldMigrateUser && lidForPN) {
                    const migrationResult = await signalRepository.migrateSession(userJids, lidForPN);
                    if (migrationResult.migrated > 0) {
                        logger.info({
                            user,
                            lidMapping: lidForPN,
                            migrated: migrationResult.migrated,
                            skipped: migrationResult.skipped,
                            total: migrationResult.total
                        }, 'Completed bulk migration for user devices');
                    } else {
                        logger.debug({
                            user,
                            lidMapping: lidForPN,
                            skipped: migrationResult.skipped,
                            total: migrationResult.total
                        }, 'All user device sessions already migrated');
                    }
                }
                const addMissingSessionsToFetchList = (jid) => {
                    const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                    if (sessions[signalId]) return;
                    if (jid.includes('@s.whatsapp.net') && shouldMigrateUser && lidForPN) {
                        const decoded = jidDecode(jid);
                        const lidDeviceJid = decoded.device !== undefined ? `${jidDecode(lidForPN).user}:${decoded.device}@lid` : lidForPN;
                        jidsRequiringFetch.push(lidDeviceJid);
                        logger.debug({ pnJid: jid, lidJid: lidDeviceJid }, 'Adding LID JID to fetch list (conversion)');
                    } else {
                        jidsRequiringFetch.push(jid);
                        logger.debug({ jid }, 'Adding JID to fetch list');
                    }
                };
                userJids.forEach(addMissingSessionsToFetchList);
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions');
            const lidUsersBeingFetched = new Set();
            const pnUsersBeingFetched = new Set();
            for (const jid of jidsRequiringFetch) {
                const user = jidDecode(jid)?.user;
                if (user) {
                    if (jid.includes('@lid')) {
                        lidUsersBeingFetched.add(user);
                    } else if (jid.includes('@s.whatsapp.net')) {
                        pnUsersBeingFetched.add(user);
                    }
                }
            }
            const overlapping = Array.from(pnUsersBeingFetched).filter(user => lidUsersBeingFetched.has(user));
            if (overlapping.length > 0) {
                logger.warn({
                    overlapping,
                    lidUsersBeingFetched: Array.from(lidUsersBeingFetched),
                    pnUsersBeingFetched: Array.from(pnUsersBeingFetched)
                }, 'Fetching both LID and PN sessions for same users');
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid }
                        }))
                    }
                ]
            });
            await parseAndInjectE2ESessions(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };

    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = jidNormalizedUser(authState.creds.me.id);
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force'
            }
        });
        return msgId;
    };

    const createParticipantNodes = async (jids, message, extraAttrs, dsmMessage) => {
        let patched = await patchMessageBeforeSending(message, jids);
        if (!Array.isArray(patched)) {
            patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched];
        }
        let shouldIncludeDeviceIdentity = false;
        const meId = authState.creds.me.id;
        const meLid = authState.creds.me?.lid;
        const meLidUser = meLid ? jidDecode(meLid)?.user : null;
        const devicesByUser = new Map();
        for (const patchedMessageWithJid of patched) {
            const { recipientJid: wireJid, ...patchedMessage } = patchedMessageWithJid;
            if (!wireJid) continue;
            const decoded = jidDecode(wireJid);
            const user = decoded?.user;
            if (!user) continue;
            if (!devicesByUser.has(user)) {
                devicesByUser.set(user, []);
            }
            devicesByUser.get(user).push({ recipientJid: wireJid, patchedMessage });
        }
        const userEncryptionPromises = Array.from(devicesByUser.entries()).map(([user, userDevices]) => encryptionMutex.mutex(user, async () => {
            logger.debug({ user, deviceCount: userDevices.length }, 'Acquiring encryption lock for user devices');
            const userNodes = [];
            const getEncryptionJid = async (wireJid) => {
                if (!wireJid.includes('@s.whatsapp.net')) return wireJid;
                try {
                    const lidForPN = await signalRepository.lidMapping.getLIDForPN(wireJid);
                    if (!lidForPN?.includes('@lid')) return wireJid;
                    const wireDecoded = jidDecode(wireJid);
                    const deviceId = wireDecoded?.device || 0;
                    const lidDecoded = jidDecode(lidForPN);
                    const lidWithDevice = jidEncode(lidDecoded?.user, 'lid', deviceId);
                    try {
                        const migrationResult = await signalRepository.migrateSession([wireJid], lidWithDevice);
                        const recipientUser = jidNormalizedUser(wireJid);
                        const ownPnUser = jidNormalizedUser(meId);
                        const isOwnDevice = recipientUser === ownPnUser;
                        logger.info({ wireJid, lidWithDevice, isOwnDevice }, 'Migrated to LID encryption');
                        try {
                            if (migrationResult.migrated) {
                                await signalRepository.deleteSession([wireJid]);
                                logger.debug({ deletedPNSession: wireJid }, 'Deleted PN session');
                            }
                        } catch (deleteError) {
                            logger.warn({ wireJid, error: deleteError }, 'Failed to delete PN session');
                        }
                        return lidWithDevice;
                    }
                    catch (migrationError) {
                        logger.warn({ wireJid, error: migrationError }, 'Failed to migrate session');
                        return wireJid;
                    }
                }
                catch (error) {
                    logger.debug({ wireJid, error }, 'Failed to check LID mapping');
                    return wireJid;
                }
            };
            for (const { recipientJid: wireJid, patchedMessage } of userDevices) {
                let messageToEncrypt = patchedMessage;
                if (dsmMessage) {
                    const { user: targetUser } = jidDecode(wireJid);
                    const { user: ownPnUser } = jidDecode(meId);
                    const ownLidUser = meLidUser;
                    const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser);
                    const isExactSenderDevice = wireJid === meId || (authState.creds.me?.lid && wireJid === authState.creds.me.lid);
                    if (isOwnUser && !isExactSenderDevice) {
                        messageToEncrypt = dsmMessage;
                        logger.debug({ wireJid, targetUser }, 'Using DSM for own device');
                    }
                }
                const bytes = encodeWAMessage(messageToEncrypt);
                const encryptionJid = await getEncryptionJid(wireJid);
                const { type, ciphertext } = await signalRepository.encryptMessage({
                    jid: encryptionJid,
                    data: bytes
                });
                if (type === 'pkmsg') {
                    shouldIncludeDeviceIdentity = true;
                }
                const node = {
                    tag: 'to',
                    attrs: { jid: wireJid },
                    content: [
                        {
                            tag: 'enc',
                            attrs: {
                                v: '2',
                                type,
                                ...(extraAttrs || {})
                            },
                            content: ciphertext
                        }
                    ]
                };
                userNodes.push(node);
            }
            logger.debug({ user, nodesCreated: userNodes.length }, 'Releasing encryption lock for user devices');
            return userNodes;
        }));
        const userNodesArrays = await Promise.all(userEncryptionPromises);
        const nodes = userNodesArrays.flat();
        return { nodes, shouldIncludeDeviceIdentity };
    };

    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        const meId = authState.creds.me.id;
        const meLid = authState.creds.me?.lid;
        let shouldIncludeDeviceIdentity = false;
        const { user, server } = jidDecode(jid);
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isPrivate = server === 's.whatsapp.net'
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        const finalJid = jid;
        let ownId = meId;
        if (isLid && meLid) {
            ownId = meLid;
            logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation');
        } else {
            logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation');
        }
        msgId = msgId || generateMessageIDV2(sock.user?.id);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus;
        const participants = [];
        const destinationJid = !isStatus ? finalJid : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo
        };
        const extraAttrs = {};
        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
            }
            const { user, device } = jidDecode(participant.jid);
            devices.push({
                user,
                device,
                wireJid: participant.jid
            });
        }
        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(message);
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType;
            }
            if (isNewsletter) {
                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message;
                const bytes = encodeNewsletterMessage(patched);
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: {},
                    content: bytes
                });
                const stanza = {
                    tag: 'message',
                    attrs: {
                        to: jid,
                        id: msgId,
                        type: getMessageType(message),
                        ...(additionalAttributes || {})
                    },
                    content: binaryNodeContent
                };
                logger.debug({ msgId }, `sending newsletter message to ${jid}`);
                await sendNode(stanza);
                return;
            }
            if (normalizeMessageContent(message)?.pinInChatMessage) {
                extraAttrs['decrypt-fail'] = 'hide';
            }
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined; // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        } else if (!isStatus) {
                            groupData = await getMetadata(jid);
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid]); // TODO: check out what if the sender key memory doesn't include the LID stuff now?
                            return result[jid] || {};
                        }
                        return {};
                    })()
                ]);
                if (!participant) {
                    const participantsList = groupData && !isStatus ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    if (!isStatus) {
                        const groupAddressingMode = groupData?.addressingMode || (isLid ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN);
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: groupAddressingMode
                        };
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new Boom('Per-jid patching is not supported in groups');
                }
                const bytes = encodeWAMessage(patched);
                const groupAddressingMode = groupData?.addressingMode || (isLid ? 'lid' : 'pn');
                const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId;
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity
                });
                const senderKeyJids = [];
                for (const device of devices) {
                    const deviceJid = device.wireJid;
                    const hasKey = !!senderKeyMap[deviceJid];
                    if (!hasKey || !!participant) {
                        senderKeyJids.push(deviceJid);
                        senderKeyMap[deviceJid] = true;
                    }
                }
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg' },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            } else {
                const { user: ownUser } = jidDecode(ownId);
                if (!participant) {
                    const targetUserServer = isLid ? 'lid' : 's.whatsapp.net';
                    devices.push({
                        user,
                        device: 0,
                        wireJid: jidEncode(user, targetUserServer, 0)
                    });
                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user;
                        devices.push({
                            user: ownUserForAddressing,
                            device: 0,
                            wireJid: jidEncode(ownUserForAddressing, ownUserServer, 0)
                        });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        devices.length = 0;
                        const senderIdentity = isLid && meLid ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined) : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined);
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], false, false);
                        devices.push(...sessionDevices);
                        logger.debug({
                            deviceCount: devices.length,
                            devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.wireJid)?.server}`)
                        }, 'Device enumeration complete with unified addressing');
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                const { user: mePnUser } = jidDecode(meId);
                const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null };
                for (const { user, wireJid } of devices) {
                    const isExactSenderDevice = wireJid === meId || (meLid && wireJid === meLid);
                    if (isExactSenderDevice) {
                        logger.debug({ wireJid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)');
                        continue;
                    }
                    const isMe = user === mePnUser || (meLidUser && user === meLidUser);
                    const jid = wireJid;
                    if (isMe) {
                        meJids.push(jid);
                    } else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                await assertSessions([...otherJids, ...meJids], false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg || message, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs, meMsg)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                if (meJids.length > 0 || otherJids.length > 0) {
                    extraAttrs['phash'] = generateParticipantHashV2([...meJids, ...otherJids]);
                }
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0];
                    if (peerNode) {
                        binaryNodeContent.push(peerNode);
                    }
                } else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    });
                }
            }
            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    to: destinationJid,
                    type: getMessageType(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            };
            if (participant) {
                if (isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                } else if (areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                } else {
                    stanza.attrs.to = participant.jid;
                }
            } else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: encodeSignedDeviceIdentity(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (additionalNodes && additionalNodes.length > 0) {
                if (!stanza.content || !Array.isArray(stanza.content)) {
                    stanza.content = []
                }
                stanza.content.push(...additionalNodes)
            }

            const messages = normalizeMessageContent(message)
            const buttonType = getButtonType(messages)
            if (!isNewsletter && buttonType) {
                const buttonsNode = getButtonArgs(messages)
                const resultFilteredButtons = getBinaryFilteredButtons(additionalNodes ? additionalNodes : [])
                if (resultFilteredButtons) {
                    stanza.content.push(additionalNodes)
                } else {
                    stanza.content.push(buttonsNode)
                }
            }

            if (isPrivate) {
                if (!stanza.content || !Array.isArray(stanza.content)) {
                    stanza.content = []
                }
                stanza.content.push({
                    tag: 'bot',
                    attrs: {
                        biz_bot: '1'
                    }
                })
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
            if (messageRetryManager && !participant) {
                messageRetryManager.addRecentMessage(destinationJid, msgId, message);
            }
        }, meId);
        return msgId;
    };

    const getMessageType = (message) => {
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
            return 'poll';
        }
        if (message.eventMessage) {
            return 'event';
        }
        return 'text';
    };

    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image';
        } else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video';
        } else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio';
        } else if (message.contactMessage) {
            return 'vcard';
        } else if (message.documentMessage) {
            return 'document';
        } else if (message.contactsArrayMessage) {
            return 'contact_array';
        } else if (message.liveLocationMessage) {
            return 'livelocation';
        } else if (message.stickerMessage) {
            return 'sticker';
        } else if (message.listMessage) {
            return 'list';
        } else if (message.listResponseMessage) {
            return 'list_response';
        } else if (message.buttonsResponseMessage) {
            return 'buttons_response';
        } else if (message.orderMessage) {
            return 'order';
        } else if (message.productMessage) {
            return 'product';
        } else if (message.interactiveResponseMessage) {
            return 'native_flow_response';
        } else if (message.groupInviteMessage) {
            return 'url';
        }
    };

    const getActualMessage = (msg) => {
        return msg?.viewOnceMessage?.message || msg;
    };

    const getButtonType = (message) => {
        const actualMessage = getActualMessage(message);
        if (actualMessage?.listMessage) {
            return 'list';
        } else if (actualMessage?.buttonsMessage) {
            return 'buttons';
        } else if (actualMessage?.templateMessage) {
            return 'template';
        } else if (actualMessage?.interactiveMessage?.nativeFlowMessage) {
            return 'native_flow';
        }
    };

    const getButtonArgs = (message) => {
        const actualMessage = getActualMessage(message);
        const nativeFlowButtons = actualMessage.interactiveMessage?.nativeFlowMessage?.buttons;

        if (nativeFlowButtons?.length && (nativeFlowButtons[0].name === 'review_and_pay' || nativeFlowButtons[0].name === 'payment_info')) {
            return {
                tag: 'biz',
                attrs: { native_flow_name: nativeFlowButtons[0].name }
            };
        }

        const buttonTypes = ['mpm', 'cta_catalog', 'send_location', 'call_permission_request', 'wa_payment_transaction_details', 'automated_greeting_message_view_catalog', 'send_location'];
        const matchedButton = nativeFlowButtons?.find(b => buttonTypes.includes(b.name));
        if (matchedButton) {
            return {
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { name: matchedButton.name, v: "2" }
                    }]
                }]
            };
        }

        if (actualMessage.interactiveMessage?.nativeFlowMessage || actualMessage.buttonsMessage) {
            return {
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: {
                            name: 'mixed',
                            v: '9'
                        }
                    }]
                }]
            };
        }

        if (actualMessage.listMessage) {
            return {
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'list',
                    attrs: { type: 'product_list', v: '2' }
                }]
            };
        }

        if (actualMessage.templateMessage) {
            return {
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'hsm',
                    attrs: { tag: 'AUTHENTICATION', category: '' }
                }]
            };
        }
    };

    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    };

    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');
    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        fetchPrivacySettings,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        messageRetryManager,
        updateMediaMessage: async (message) => {
            const content = assertMediaContent(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = await encryptMediaRetryRequest(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id);
                                if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = proto.MediaRetryNotification.ResultType[media.result];
                                    throw new Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                    });
                                }
                                content.directPath = media.directPath;
                                content.url = getUrlFromDirectPath(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);
            return message;
        },
        sendStatusMentions: async (jid, content) => {
            const media = await generateWAMessage(STORIES_JID, content, {
                upload: await waUploadToServer,
                backgroundColor: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
                font: content.text ? Math.floor(Math.random() * 9) : null
            })
            const additionalNodes = [{
                tag: 'meta',
                attrs: {},
                content: [{
                    tag: 'mentioned_users',
                    attrs: {},
                    content: [{
                        tag: 'to',
                        attrs: {
                            jid
                        },
                        content: undefined,
                    }],
                }],
            }]
            let Private = isPnUser(jid)
            let statusJid = Private ? [jid] : (await getMetadata(jid)).participants.map((num) => num.id)
            await relayMessage(STORIES_JID, media.message, {
                messageId: media.key.id,
                statusJidList: statusJid,
                additionalNodes,
            })
            let type = Private ? 'statusMentionMessage' : 'groupStatusMentionMessage'
            let msg = await generateWAMessageFromContent(jid, {
                [type]: {
                    message: {
                        protocolMessage: {
                            key: media.key,
                            type: 25,
                        }
                    }
                },
                messageContextInfo: {
                    messageSecret: randomBytes(32)
                }
            }, {})
            await relayMessage(jid, msg.message, {
                additionalNodes: Private ? [{
                    tag: 'meta',
                    attrs: {
                        is_status_mention: 'true'
                    },
                    content: undefined,
                }] : undefined
            }, {})
            return media
        },
        sendAlbumMessage: async (jid, medias, options = {}) => {
            const userJid = authState.creds.me.id
            for (const media of medias) {
                if (!media.image && !media.video) throw new TypeError(`medias[i] must have image or video property`)
            }
            if (medias.length < 2) throw new RangeError("Minimum 2 media")
            const time = options.delay || 500
            delete options.delay
            const album = await generateWAMessageFromContent(jid, {
                albumMessage: {
                    expectedImageCount: medias.filter(media => media.image).length,
                    expectedVideoCount: medias.filter(media => media.video).length,
                    ...options
                }
            }, {
                userJid,
                ...options
            })
            await relayMessage(jid, album.message, {
                messageId: album.key.id
            })
            let mediaHandle
            let msg
            for (const i in medias) {
                const media = medias[i]
                if (media.image) {
                    msg = await generateWAMessage(jid, {
                        image: media.image,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options
                    })
                } else if (media.video) {
                    msg = await generateWAMessage(jid, {
                        video: media.video,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options,
                    })
                }
                if (msg) {
                    msg.message.messageContextInfo = {
                        messageSecret: randomBytes(32),
                        messageAssociation: {
                            associationType: 1,
                            parentMessageKey: album.key
                        }
                    }
                }
                await relayMessage(jid, msg.message, {
                    messageId: msg.key.id
                })
                await delay(time)
            }
            return album
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean'
                    ? disappearingMessagesInChat
                        ? WA_DEFAULT_EPHEMERAL
                        : 0
                    : disappearingMessagesInChat;
                await groupToggleEphemeral(jid, value);
            }
            else {
                const fullMsg = await generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    getUrlInfo: text => getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...(axiosOptions || {})
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    getProfilePicUrl: sock.profilePictureUrl,
                    getCallLink: sock.createCallLink,
                    upload: waUploadToServer,
                    mediaCache: config.mediaCache,
                    options: config.options,
                    messageId: generateMessageIDV2(sock.user?.id),
                    ...options
                });
                const isEventMsg = 'event' in content && !!content.event;
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isPollMessage = 'poll' in content && !!content.poll;
                const additionalAttributes = {};
                const additionalNodes = [];
                if (isDeleteMsg) {
                    if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                }
                else if (isEditMsg) {
                    additionalAttributes.edit = '1';
                }
                else if (isPinMsg) {
                    additionalAttributes.edit = '2';
                }
                else if (isPollMessage) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            polltype: 'creation'
                        }
                    });
                }
                else if (isEventMsg) {
                    additionalNodes.push({
                        tag: 'meta',
                        attrs: {
                            event_type: 'creation'
                        }
                    });
                }
                if ('cachedGroupMetadata' in options) {
                    console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.');
                }
                await relayMessage(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    additionalNodes
                });
                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        processingMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                return fullMsg;
            }
        }
    };
};
//# sourceMappingURL=messages-send.js.map