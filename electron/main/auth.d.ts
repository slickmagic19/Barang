// Hand-written typings for auth.js so web-side tests can import the pure
// auth logic under strict tsc without allowJs. Keep in sync with auth.js.
export interface AuthStatus {
  loggedIn?: boolean;
  user?: string;
  plan?: string;
  [k: string]: unknown;
}

export function authFilePath(userDataDir: string): string;
export function readStoredKey(userDataDir: string): Promise<string | null>;
export function writeStoredKey(userDataDir: string, key: string): Promise<void>;
export function clearStoredKey(userDataDir: string): Promise<void>;
export function authEnv(storedKey: string | null, baseEnv?: Record<string, string>): Record<string, string>;
export function parseAuthStatus(stdout: string, exitCode: number): AuthStatus;
export function normalizeKey(raw: unknown): string;
export function isKeyLike(k: unknown): boolean;
export function publicStatus(parsed: AuthStatus | null | undefined): AuthStatus;
export function parseDeviceAuth(output: unknown): { url?: string; code?: string; [k: string]: unknown };
export function hasStoredCredential(authJson: unknown): boolean;
export const ACCOUNT_LINKS: Record<string, string>;
