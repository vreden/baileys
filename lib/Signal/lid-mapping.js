"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const lru_cache_1 = require("lru-cache")
const WABinary_1 = require("../WABinary")

class LIDMappingStore {
	constructor(keys, onWhatsAppFunc, logger) {
		this.mappingCache = new lru_cache_1.LRUCache({
            ttl: 7 * 24 * 60 * 60 * 1000,
            ttlAutopurge: true,
            updateAgeOnGet: true
        })
		this.keys = keys
		this.logger = logger
		this.onWhatsAppFunc = onWhatsAppFunc
	}

    async storeLIDPNMappings(pairs) {
        const pairMap = {}
        const logger = this.logger

        for (const { lid, pn } of pairs) {
            if (!((WABinary_1.isLidUser(lid) && WABinary_1.isJidUser(pn)) || (WABinary_1.isJidUser(lid) && WABinary_1.isLidUser(pn)))) {
                logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`)
                continue
            }

            const [lidJid, pnJid] = WABinary_1.isLidUser(lid) ? [lid, pn] : [pn, lid]
            const lidDecoded = WABinary_1.jidDecode(lidJid)
            const pnDecoded = WABinary_1.jidDecode(pnJid)

            if (!lidDecoded || !pnDecoded) return

            const pnUser = pnDecoded.user
            const lidUser = lidDecoded.user

            let existingLidUser = this.mappingCache.get(`pn:${pnUser}`)
            if (!existingLidUser) {
                const stored = await this.keys.get('lid-mapping', [pnUser])

                existingLidUser = stored[pnUser]
                if (existingLidUser) {
                    this.mappingCache.set(`pn:${pnUser}`, existingLidUser)
                    this.mappingCache.set(`lid:${existingLidUser}`, pnUser)
                }
            }

            if (existingLidUser === lidUser) {
                logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
                continue
            }

            pairMap[pnUser] = lidUser
        }

        logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`)

        await this.keys.transaction(async () => {
            for (const [pnUser, lidUser] of Object.entries(pairMap)) {
                await this.keys.set({
                    'lid-mapping': {
                        [pnUser]: lidUser,
                        [`${lidUser}_reverse`]: pnUser
                    }
                })

                this.mappingCache.set(`pn:${pnUser}`, lidUser)
                this.mappingCache.set(`lid:${lidUser}`, pnUser)
            }
        }, 'lid-mapping')
    }

    async getLIDForPN(pn) {
        if (!WABinary_1.isJidUser(pn)) return null

        const logger = this.logger
        const decoded = WABinary_1.jidDecode(pn)
        if (!decoded) return null

        const pnUser = decoded.user

        let lidUser = this.mappingCache.get(`pn:${pnUser}`)
        if (!lidUser) {
            const stored = await this.keys.get('lid-mapping', [pnUser])

            lidUser = stored[pnUser]
            if (lidUser) {
                this.mappingCache.set(`pn:${pnUser}`, lidUser)
            } else {
                logger.trace(`No LID mapping found for PN user ${pnUser}; getting from USync`)

                const { exists, lid } = (await this.onWhatsAppFunc?.(pn))?.[0]
                if (exists && lid) {
                    lidUser = WABinary_1.jidDecode(lid)?.user
                    if (lidUser) {
                        await this.keys.transaction(async () => {
                            await this.keys.set({
                                'lid-mapping': {
                                    [pnUser]: lidUser,
                                    [`${lidUser}_reverse`]: pnUser
                                }
                            })
                        }, 'lid-mapping')
                    
                        this.mappingCache.set(`pn:${pnUser}`, lidUser)
                        this.mappingCache.set(`lid:${lidUser}`, pnUser)
                    }
                } else {
                    return null
                }
            }
        }

        if (typeof lidUser !== 'string' || !lidUser) {
            logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`)
            return null
        }

        const pnDevice = decoded.device !== undefined ? decoded.device : 0
        const deviceSpecificLid = `${lidUser}:${pnDevice}@lid`
        logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`)

        return deviceSpecificLid
    }

    async getPNForLID(lid) {
        if (!WABinary_1.isLidUser(lid)) return null

        const logger = this.logger
        const decoded = WABinary_1.jidDecode(lid)
        if (!decoded) return null

        const lidUser = decoded.user

        let pnUser = this.mappingCache.get(`lid:${lidUser}`)
        if (!pnUser || typeof pnUser !== 'string') {
            const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`]);

            pnUser = stored[`${lidUser}_reverse`]
            if (!pnUser || typeof pnUser !== 'string') {
                logger.trace(`No reverse mapping found for LID user: ${lidUser}`)
                return null
            }
            this.mappingCache.set(`lid:${lidUser}`, pnUser)
        }

        const lidDevice = decoded.device !== undefined ? decoded.device : 0
        const pnJid = `${pnUser}:${lidDevice}@s.whatsapp.net`
        logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`)

        return pnJid
    }
}

module.exports = {
  LIDMappingStore
}