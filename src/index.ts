import Base58 = require('base-58')
import _sodium = require('libsodium-wrappers')

interface IUnpackedMsg {
    message: string,
    recipientKey: any,
    senderKey: any
}

export class PackUnpack {

    private sodium: any
    private initalized: boolean

    constructor() {
        this.initalized = false
    }

    public async setup() {
        await _sodium.ready
        this.sodium = _sodium
        this.initalized = true
    }

    /**
     *
     * @param message string message to be encrypted
     * @param toKeys public key of the entity encrypting message for
     * @param fromKeys keypair of person encrypting message
     */
    public async packMessage(
        message: string, toKeys: Uint8Array[], fromKeys: _sodium.KeyPair | null = null): Promise<string> {

        if (!this.initalized) {
            await this.setup()
        }

        const [recipsJson, cek] = this.prepareRecipientKeys(toKeys, fromKeys)
        const recipsB64 = this.b64url(recipsJson)

        const [ciphertext, tag, iv] = this.encryptPlaintext(message, recipsB64, cek)

        return JSON.stringify({
            ciphertext: this.b64url(ciphertext),
            iv: this.b64url(iv),
            protected: recipsB64,
            tag: this.b64url(tag),
        })
    }

    /**
     *
     * @param encMsg message to be decrypted
     * @param toKeys key pair of party decrypting the message
     */
    public async unpackMessage(encMsg: string, toKeys: _sodium.KeyPair): Promise<IUnpackedMsg> {

        if (!this.initalized) {
            await this.setup()
        }

        let wrapper
        if (typeof encMsg === 'string') {
            wrapper = JSON.parse(encMsg)
        } else {
            wrapper = encMsg
        }
        if (typeof toKeys.publicKey === 'string') {
            toKeys.publicKey = Base58.decode(toKeys.publicKey)
        }
        if (typeof toKeys.privateKey === 'string') {
            toKeys.privateKey = Base58.decode(toKeys.privateKey)
        }
        const recipsJson = this.strB64dec(wrapper.protected)
        const recipsOuter = JSON.parse(recipsJson)

        const alg = recipsOuter.alg
        const isAuthcrypt = alg === 'Authcrypt'
        if (!isAuthcrypt && alg !== 'Anoncrypt') {
            throw new Error('Unsupported pack algorithm: ' + alg)
        }
        const [cek, senderVk, recipVk] = this.locateRecKey(recipsOuter.recipients, toKeys)
        if (!senderVk && isAuthcrypt) {
            throw new Error('Sender public key not provided in Authcrypt message')
        }
        const ciphertext = this.b64dec(wrapper.ciphertext)
        const nonce = this.b64dec(wrapper.iv)
        const tag = this.b64dec(wrapper.tag)

        const message = this.decryptPlaintext(ciphertext, tag, wrapper.protected, nonce, cek)
        return {
            message,
            recipientKey: recipVk,
            senderKey: senderVk,
        }
    }

    /**
     * Uses libsodium to generate a key pair, you may pass these keys into the pack/unpack functions
     */
    public async generateKeyPair(): Promise<_sodium.KeyPair> {

        if (!this.initalized) {
            await this.setup()
        }

        return this.sodium.crypto_sign_keypair()
    }

    private b64url(input: any) {
        return this.sodium.to_base64(input, this.sodium.base64_variants.URLSAFE)
    }

    private b64dec(input: any) {
        return this.sodium.from_base64(input, this.sodium.base64_variants.URLSAFE)
    }

    private strB64dec(input: any) {
        return this.sodium.to_string(this.sodium.from_base64(input, this.sodium.base64_variants.URLSAFE))
    }

    private encryptPlaintext(message: any, addData: any, key: any) {
        const iv = this.sodium.randombytes_buf(this.sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)
        const out = this.sodium.crypto_aead_chacha20poly1305_ietf_encrypt_detached(message, addData, null, iv, key)
        return [out.ciphertext, out.mac, iv]
    }

    private decryptPlaintext(ciphertext: any, mac: any, recipsBin: any, nonce: any, key: any) {
        return this.sodium.to_string(
            this.sodium.crypto_aead_chacha20poly1305_ietf_decrypt_detached(
                null, // nsec
                ciphertext,
                mac,
                recipsBin, // ad
                nonce, // npub
                key,
            ),
        )
    }

    private prepareRecipientKeys(toKeys: any, fromKeys: any = null) {
        const cek = this.sodium.crypto_secretstream_xchacha20poly1305_keygen()
        const recips: any[] = []

        toKeys.forEach((targetVk: any) => {
            let encCek = null
            let encSender = null
            let nonce = null

            const targetPk = this.sodium.crypto_sign_ed25519_pk_to_curve25519(targetVk)

            if (fromKeys) {
                const senderVk = Base58.encode(fromKeys.publicKey)
                const senderSk = this.sodium.crypto_sign_ed25519_sk_to_curve25519(fromKeys.privateKey)
                encSender = this.sodium.crypto_box_seal(senderVk, targetPk)

                nonce = this.sodium.randombytes_buf(this.sodium.crypto_box_NONCEBYTES)
                encCek = this.sodium.crypto_box_easy(cek, nonce, targetPk, senderSk)
            } else {
                encCek = this.sodium.crypto_box_seal(cek, targetPk)
            }

            recips.push(
                {
                    encrypted_key: this.b64url(encCek),
                    header: {
                        iv: nonce ? this.b64url(nonce) : null,
                        kid: Base58.encode(targetVk),
                        sender: encSender ? this.b64url(encSender) : null,
                    },
                },
            )
        })

        const data = {
            alg: fromKeys ? 'Authcrypt' : 'Anoncrypt',
            enc: 'xchacha20poly1305_ietf',
            recipients: recips,
            typ: 'JWM/1.0',
        }
        return [JSON.stringify(data), cek]
    }

    private locateRecKey(recipients: any, keys: any) {
        const notFound = []
        /* tslint:disable */
        for (let index in recipients) {
            const recip = recipients[index]
            if (!('header' in recip) || !('encrypted_key' in recip)) {
                throw new Error('Invalid recipient header')
            }

            const recipVk = Base58.decode(recip.header.kid)
            if (!this.sodium.memcmp(recipVk, keys.publicKey)) {
                notFound.push(recip.header.kid)
            }
            const pk = this.sodium.crypto_sign_ed25519_pk_to_curve25519(keys.publicKey)
            const sk = this.sodium.crypto_sign_ed25519_sk_to_curve25519(keys.privateKey)

            const encrytpedKey = this.b64dec(recip.encrypted_key)
            const nonce = recip.header.iv ? this.b64dec(recip.header.iv) : null
            const encSender = recip.header.sender ? this.b64dec(recip.header.sender) : null

            let senderVk = null
            let cek = null
            if (nonce && encSender) {
                senderVk = this.sodium.to_string(this.sodium.crypto_box_seal_open(encSender, pk, sk))
                const senderPk = this.sodium.crypto_sign_ed25519_pk_to_curve25519(Base58.decode(senderVk))
                cek = this.sodium.crypto_box_open_easy(encrytpedKey, nonce, senderPk, sk)
            } else {
                cek = this.sodium.crypto_box_seal_open(encrytpedKey, pk, sk)
            }
            return [cek, senderVk, recip.header.kid]
        }

        throw new Error('No corresponding recipient key found in recipients')
    }
}
