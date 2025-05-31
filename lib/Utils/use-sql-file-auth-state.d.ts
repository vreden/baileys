import { AuthenticationState } from '../Types'

export declare const useSqlAuthState: (collection: string) => Promise<{
    state: AuthenticationState
    saveCreds: () => Promise<void>
}>
