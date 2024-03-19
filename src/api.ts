// server

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import jws, { Algorithm, Header } from 'jws'
import jwkToPem, { JWK } from 'jwk-to-pem'
import { randomUUID, createHash } from 'crypto';
import { serialize as serializeCookie, parse as parseCookies } from 'cookie'

import { JWKS, PRIVATE_KEY, PUBLIC_KEY } from './jwks'
import * as state from './state'

import {
    TOKEN_ENDPOINT,
    REVOCATION_ENDPOINT,
    JWKS_ENDPOINT,
    LOGIN_ENDPOINT,
    ACCESS_LIFETIME,
    STATE_LIFETIME,
    REFRESH_LIFETIME,
    DPOP_LIFETIME
} from './constants'

interface Payload {
    iss: string
    sub: string
    aud: string
    client_id: string
    token_type: string
    iat: number
    exp: number
    jti: string
    cnf?: {
        jkt: string
    }

}

const HOST = process.env.HOST
const PORT: number = Number(process.env.PORT) || 3000
const USE_DPOP: boolean = !process.env.SUPPRESS_DPOP_CHECK

const BASE_URL = (HOST)
    ? `https://${HOST}`
    : `http://localhost:${PORT}`
const HTU = BASE_URL + TOKEN_ENDPOINT

const PRODUCTION = (process.env.NODE_ENV === 'production')

const JWT_HEADER: Header = {
    alg: 'RS256',
    typ: 'jwt',
    kid: JWKS.keys[0].kid
}
const AT_HEADER: Header = {
    alg: 'RS256',
    typ: 'at+jwt',
    kid: JWKS.keys[0].kid
}

// OAuth 2.0 Authorization Server Metadata
interface MetaData {
    issuer: string;
    token_endpoint: string;
    jwks_uri: string;
    grant_types_supported: string[];
    revocation_endpoint: string;
    dpop_signing_alg_values_supported?: string[];
}
const META_DATA: MetaData = {
    issuer: BASE_URL,
    token_endpoint: `${BASE_URL}${TOKEN_ENDPOINT}`,
    jwks_uri: `${BASE_URL}${JWKS_ENDPOINT}`,
    grant_types_supported: [
        'authorization_code', 
        'client_credentials', 
        'refresh_token',
        'cookie_token', // non-standard
    ],
    revocation_endpoint: `${BASE_URL}${REVOCATION_ENDPOINT}`,   
}
if (USE_DPOP) {
    META_DATA.dpop_signing_alg_values_supported = ['RS256']
}


// console.log('/.well-known/oauth-authorization-server', JSON.stringify(META_DATA, null, 2))

class TokenError extends Error {
    statusCode: number; 
  
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode || 500
      Object.setPrototypeOf(this, TokenError.prototype); // Fix prototype chain
      Error.captureStackTrace(this, this.constructor);
    }
}

const generateThumbprint = function(jwk: JWK) {
    const ordered = JSON.stringify(jwk, Object.keys(jwk).sort());
    const hash = createHash('sha256').update(ordered).digest('base64url');
    return hash;
}

const setTokenCookies = (reply: FastifyReply, access_token: string, refresh_token: string) => {

    const accessTokenCookie = serializeCookie('access_token', access_token || '', {
        maxAge: access_token ? ACCESS_LIFETIME : 0,
        httpOnly: true,
        path: '/',
        secure: PRODUCTION,
        sameSite: 'strict',
    })

    const refreshTokenCookie = serializeCookie('refresh_token', refresh_token || '', {
        maxAge: refresh_token ? REFRESH_LIFETIME : 0,
        httpOnly: true,
        path: TOKEN_ENDPOINT,
        secure: PRODUCTION,
        sameSite: 'strict',
    })

    reply.header('Set-Cookie', [accessTokenCookie, refreshTokenCookie]);
}

const setSessionCookie = (reply: FastifyReply, session_token: string) => {

    const sessionTokenCookie = serializeCookie('session_token', session_token || '', {
        maxAge: session_token ? STATE_LIFETIME : 0,
        httpOnly: true,
        path: TOKEN_ENDPOINT,
        secure: PRODUCTION,
        sameSite: 'strict',
    })
    reply.header('Set-Cookie', sessionTokenCookie);
}

const getCookies = (req: FastifyRequest): Record<string, string> => {
    const cookies = req.headers['cookie']
    if (!cookies) {
        return {}
    }
    return parseCookies(cookies)
}

const validateDPoP = (req: FastifyRequest): string => {
    if (!USE_DPOP)
        return ''
    const dpop = req.headers['dpop']
    if (!dpop) {
        throw new TokenError(400, 'DPoP header is required')
    }
    if (Array.isArray(dpop)) {
        throw new TokenError(400, 'Only one DPoP header is allowed')
    }
    const { header, payload } = jws.decode(dpop as string, { json: true })
    if (!header || !payload) {
        throw new TokenError(400, 'DPoP header is invalid')
    }
    const { typ, alg, jwk } = header as { typ: string, alg: Algorithm, jwk: JWK}
    if (typ !== 'dpop+jwt') {
        throw new TokenError(400, 'DPoP typ is invalid')
    }
    if (META_DATA?.dpop_signing_alg_values_supported?.indexOf(alg) === -1){
        throw new TokenError(400, 'DPoP alg is invalid')
    }
    if (!jwk) {
        throw new TokenError(400, 'DPoP header is invalid')
    }
    const { jti, htm, htu, iat } = payload
    if (!jti || !htm || !htu || !iat) {
        throw new TokenError(400, 'DPoP payload is invalid')
    }
    const now = Math.floor(Date.now() / 1000)
    if (iat + DPOP_LIFETIME < now) {
        throw new TokenError(400, 'DPoP is expired')
    }
    if (htm !== 'POST') {
        throw new TokenError(400, 'DPoP method is invalid')
    }
    if (htu !== HTU) {
        throw new TokenError(400, 'DPoP path is invalid')
    }
    const pem = jwkToPem(jwk)

    if (!jws.verify(dpop, alg, pem))
        throw new TokenError(400, 'DPoP signature is invalid')
    const jkt = generateThumbprint(jwk)
    return jkt
}   

const refreshFromCode = async (code: string, client_id: string, jkt: string): Promise<string> => {
    const currentState = await state.read(code)
    if (!currentState) {
        throw new TokenError(400, 'code is invalid')
    }
    if (!currentState.loggedIn) {
        throw new TokenError(400, 'code is not logged in')
    }
    if (currentState.iss !== BASE_URL) {
        throw new TokenError(400, 'code invalid issuer')
    }
    const now = Math.floor(Date.now() / 1000)
    if (currentState.exp < now) {
        throw new TokenError(400, 'code is expired')
    }
    // check one time use of code
    if (currentState.code_used) {
        // future - logout user to revoke issued refresh_token
        throw new TokenError(400, 'code has already been used')
    }
    currentState.code_used = now 
    await state.update(code, currentState)

    const payload: Payload = {
        iss: BASE_URL,
        sub: currentState.sub as string,
        aud: currentState.aud as string,
        client_id,
        token_type: 'refresh_token',
        iat: now,
        exp: now + REFRESH_LIFETIME,
        jti: randomUUID(),
    }
    if (USE_DPOP) {
        payload.cnf = {
            jkt: jkt
        }
    }

    payload.token_type = 'refresh_token'
    payload.iat = now
    payload.exp = now + REFRESH_LIFETIME
    const refresh_token = jws.sign({
        header: JWT_HEADER,
        payload,
        privateKey: PRIVATE_KEY
    })
    return refresh_token
}

const refreshFromRefresh = (refresh_token: string): string => {
    const { header, payload } = jws.decode(refresh_token, { json: true })
    if (!header || !payload) {
        throw new TokenError(400, 'refresh_token is invalid')
    }
    if (!jws.verify(refresh_token, header.alg, PUBLIC_KEY))
        throw new TokenError(400, 'refresh_token is invalid')
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp < now) {
        throw new TokenError(400, 'refresh_token is expired')
    }

// FUTURE -- check if user has been logged out since refresh_token was issued

    payload.iat = now
    payload.exp = now + REFRESH_LIFETIME
    payload.jti = randomUUID()
    const newRefreshToken = jws.sign({
        header: JWT_HEADER,
        payload,
        privateKey: PRIVATE_KEY
    })
    return newRefreshToken
}

const refreshFromSession = async (session_token: string) => {
    // lookup session_token and get payload 
    const { header, payload } = jws.decode(session_token, { json: true })
    // TODO -- verify session_token
    if (!header || !payload) {
        throw new TokenError(400, 'session_token is invalid')
    }
    if (payload.token_type !== 'session_token') {
        throw new TokenError(400, 'session_token is invalid')
    }
    const now = Math.floor(Date.now() / 1000)
    // check if expired
    if (payload.exp < now) {
        throw new TokenError(400, 'session_token is expired')
    }
    const currentState = await state.read(payload.nonce)
    if (!currentState) {
        throw new TokenError(400, 'session state has expired')
    }
    if (!currentState.loggedIn) {
        throw new TokenError(400, 'session state is not logged in')
    }
    if (currentState.iss !== BASE_URL) {
        throw new TokenError(400, 'session_token invalid issuer')
    }
    const refreshPayload = {
        iss: BASE_URL,
        sub: currentState.sub,
        aud: currentState.aud,
        client_id: payload.client_id,
        token_type: 'refresh_token',
        iat: now,
        exp: now + REFRESH_LIFETIME,
        jti: randomUUID()
    }
    const newRefreshToken = jws.sign({
        header: JWT_HEADER,
        payload: refreshPayload,
        privateKey: PRIVATE_KEY
    })
    return newRefreshToken
}

const accessFromRefresh = (refresh_token: string): string => {
    const { header, payload } = jws.decode(refresh_token, { json: true })
    if (!header || !payload) {
        throw new TokenError(400, 'refresh_token is invalid')
    }
    if (payload.token_type !== 'refresh_token') {
        throw new TokenError(400, 'refresh_token is invalid')
    }
    const now = Math.floor(Date.now() / 1000)
    // check if expired 
    if (payload.exp < now) {
        throw new TokenError(400, 'refresh_token is expired')
    }
    if (!jws.verify(refresh_token, header.alg, PUBLIC_KEY))
        throw new TokenError(400, 'refresh_token is invalid')
    payload.token_type = 'access_token'
    payload.iat = now
    payload.exp = now + ACCESS_LIFETIME
    payload.jwi = randomUUID()
    const newAccessToken = jws.sign({
        header: AT_HEADER,
        payload,
        privateKey: PRIVATE_KEY
    })
    return newAccessToken
}

const makeSessionToken = async (client_id: string): Promise<{session_token: string, nonce: string}> => {
    const nonce = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const currentState: state.State = {
        iss: BASE_URL,
        loggedIn: false,
        exp: now + STATE_LIFETIME,
        nonce
    }
    await state.create(nonce, currentState)
    const params = {
        header: JWT_HEADER,
        payload: {
            token_type: 'session_token',
            iss: BASE_URL,
            iat: now,
            exp: now + STATE_LIFETIME,
            client_id,
            nonce
        },
        privateKey: PRIVATE_KEY
    }
    const session_token = jws.sign(params)
    return { session_token, nonce }
}

const tokenEndpoint = async (req: FastifyRequest, reply: FastifyReply) => {
    const { grant_type, client_id, refresh_token, code } = req.body as
        { grant_type: string, client_id: string, refresh_token: string, code: string }

    // console.log({grant_type, headers: req.headers, cookies: req.headers['cookie']})


    try {
        if (grant_type === 'authorization_code') {
            if (!client_id) {
                return reply.code(400).send({error:'invalid_request', error_description:'client_id is required'})
            }
            if (!code) {
                return reply.code(400).send({error:'invalid_request', error_description:'code is required'})
            }
            const jkt = validateDPoP(req)
            const newRefreshToken = await refreshFromCode(code, client_id, jkt)
            const newAccessToken = accessFromRefresh(newRefreshToken)
            return reply.send({
                access_token: newAccessToken,
                token_type: USE_DPOP ? 'DPoP' : 'Bearer',
                expires_in: ACCESS_LIFETIME,
                refresh_token: newRefreshToken
            })
        }

        if (grant_type === 'refresh_token') {
            if (!refresh_token){ 
                return reply.code(400).send({error:'invalid_request', error_description:'refresh_token is required'})
            }
            const jwt = validateDPoP(req)
            const {payload} = jws.decode(refresh_token, { json: true })
            if (USE_DPOP) {
                if (!payload?.cnf?.jkt) {
                    throw new TokenError(400, 'refresh_token is invalid')
                }
                if (payload.cnf.jkt !== jwt) {
                    throw new TokenError(400, 'DPoP jkt does not match refresh_token jkt')
                }
            }
            if (!jws.verify(refresh_token, 'RS256', PUBLIC_KEY))
                throw new TokenError(400, 'refresh_token is invalid')
            const newRefreshToken = refreshFromRefresh(refresh_token)
            const newAccessToken = accessFromRefresh(newRefreshToken)
            return reply.send({
                access_token: newAccessToken,
                token_type: USE_DPOP ? 'DPoP' : 'Bearer',
                expires_in: ACCESS_LIFETIME,
                refresh_token: newRefreshToken
            })
        }

        if (grant_type === 'cookie_token') { // non-standard
            if (!client_id) {
                return reply.code(400).send({error:'invalid_request', error_description:'client_id is required'})
            }
            const { session_token, refresh_token } = getCookies(req)
            if (!session_token && !refresh_token) {
                // no existing session
                const { session_token, nonce } = await makeSessionToken(client_id)
                setSessionCookie(reply, session_token )
                return reply.send({
                    loggedIn: false,
                    nonce
                })
            }

            // we have an existing session
            const newRefreshToken = (refresh_token)
                ? refreshFromRefresh(refresh_token)
                : await refreshFromSession(session_token)
            const newAccessToken = accessFromRefresh(newRefreshToken)
            setTokenCookies(reply, newAccessToken, newRefreshToken)
            return reply.send({
                loggedIn: true
            })
        }

        if (grant_type === 'client_credentials') {
            return reply.code(501).send('Not Implemented')
        }
        reply.code(400).send({error:'unsupported_grant_type'})
    } catch (e) {
        const error = e as TokenError
        console.error(error)
        reply.code(error.statusCode).send({error: error.message})
    }
}

const loginEndpoint = async (req: FastifyRequest, reply: FastifyReply) => {
    const { sub, nonce } = req.body as { sub: string, nonce: string }

    // console.log({sub, nonce, headers: req.headers, cookies: req.headers['cookie']})


    if (!sub) {
        return reply.code(400).send({error:'invalid_request', error_description:'sub is required'})
    }
    if (!nonce) {
        return reply.code(400).send({error:'invalid_request', error_description:'nonce is required'})
    }
    const currentState = await state.read(nonce)
    if (!currentState) {
        return reply.code(400).send({error:'invalid_request', error_description:'nonce is invalid'})
    }
    if (currentState.loggedIn) {
        return reply.code(400).send({error:'invalid_request', error_description:'nonce is already logged in'})
    }
    const now = Math.floor(Date.now() / 1000)
    if (currentState.exp < now) {
        return reply.code(400).send({error:'invalid_request', error_description:'state has expired'})
    }

    await state.update(nonce, { 
        iss: BASE_URL,
        exp: now + STATE_LIFETIME,
        nonce,
        loggedIn: true, 
        sub 
    })
    reply.code(202)
}

const api = (app: FastifyInstance) => {
    app.register(formbody);
    app.post(LOGIN_ENDPOINT, loginEndpoint)
    app.post(TOKEN_ENDPOINT, tokenEndpoint)
    app.post(REVOCATION_ENDPOINT, (req, reply) => {
        reply.code(501).send('Not Implemented')
    })
    app.get(JWKS_ENDPOINT, (req, reply) => {
        reply.send(JWKS)
    })
    app.get('/.well-known/oauth-authorization-server', (req, reply) => {
        reply.send(META_DATA)
    })
}

export { api, PORT }