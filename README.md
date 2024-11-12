# Baileys WhatsApp Web

[![NPM Version](https://img.shields.io/npm/v/baileys.svg)](https://www.npmjs.com/package/baileys)
[![Downloads](https://img.shields.io/npm/dm/baileys.svg)](https://www.npmjs.com/package/baileys)
[![Build Status](https://travis-ci.org/adiwajshing/baileys.svg?branch=main)](https://travis-ci.org/adiwajshing/baileys)

Librari Node.js untuk terhubung ke WhatsApp Web. Baileys menyediakan API yg powerful dan mudah dipahami untuk berinteraksi dengan WhatsApp.  Lo bisa kirim pesan teks, gambar, video, audio, dokumen, bikin grup, dsb.

## Fitur Keren 😎

*Multi-Device:* Bisa pake banyak device sekaligus. Gausu ribet logout sana-sini.
*Kirim Berbagai Jenis Pesan:* Teks, gambar, video, audio, dokumen, stiker, location, kontak, sampe voice note jg bisa!
*Manajemen Grup:* Bikin grup, invite/remove member, ganti deskripsi dan subjek grup.
*Fitur Interaktif:*  Bikin tombol, list, dan respon interaktif lainnya.
*Mendukung Stiker & Emoji:*  Biar chat makin seru dan ekspresif!
*Event Handling:*  Tangkep berbagai event WhatsApp, kek pesan masuk, status online, dsb.
*Otomatis reconnect:*  Kalo koneksi putus, otomatis nyambung lagi.

## Instalasi ⚙️

```bash
npm install baileys
// atau
yarn add baileys
```

## Cara Pake 👨‍💻

Contoh simpel buat kirim pesan teks:

```javascript
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@adiwajshing/baileys')

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info') // nama folder untuk nyimpen kredensial

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // tampilin QR code di terminal
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Koneksi ditutup:', lastDisconnect.error, ', reconnecting:', shouldReconnect)
            // reconnect kalo perlu
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
            console.log('Terhubung!')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async m => {
        console.log(JSON.stringify(m, undefined, 2))

        try {
            const message = m.messages[0]
            if (!message.key.fromMe && message.key.remoteJid !== 'status@broadcast') {
                console.log('pesan masuk:', message.message.conversation)
               await sock.sendMessage(message.key.remoteJid, { text: 'Halo! 👋' }, { quoted: message }) // balas pesan
            }
        } catch (err) {
            console.log(err)
        }


    })
}

connectToWhatsApp()
```


## Dokumentasi Lengkap 📚

[Dokumentasi Baileys](https://adiwajshing.github.io/Baileys/)

## Kontribusi 🤝

Pull request sangat diterima!  Kalo nemu bug atau mau nambahin fitur,  langsung aja bikin PR.  Gw bakal review secepatnya.
[WhatsApp](https://wa.me/6287824695047)
[Website](https://vreden.my.id)
[Channel](https://whatsapp.com/channel/0029Vaf0HPMLdQeZsp3XRp2T)

## Lisensi 📜

[MIT](LICENSE)
*dibuat oleh bochel FF dengan chatGPT*



