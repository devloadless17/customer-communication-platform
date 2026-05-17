/**
 * Client-safe password policy constant.
 *
 * Lives in its own file (no `server-only` import) so that registration /
 * invite-accept / change-password client forms can render the same minLength
 * the server enforces. `password.ts` re-exports this so server code keeps
 * its single import path.
 */
export const MIN_PASSWORD_LENGTH = 6;
