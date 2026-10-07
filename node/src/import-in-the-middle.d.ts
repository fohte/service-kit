// TypeScript does not associate the upstream `.d.ts` with its `.mjs` subpath.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: Array<string | RegExp>
    exclude?: Array<string | RegExp>
  }): void

  export function supportsSyncHooks(): boolean
}
