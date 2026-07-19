export {
  connect,
  withTransaction,
  type Database,
  type DatabaseHandle,
  type Executor,
  type Transaction,
} from './client.js';
export {
  IllegalStatusTransitionError,
  NotFoundError,
  TransitionRaceLostError,
} from './errors.js';
export * as schema from './schema/index.js';

export {
  ALL_POST_STATUSES,
  assertLegalPostTargetTransition,
  assertLegalPostTransition,
  isLegalPostTargetTransition,
  isLegalPostTransition,
  legalTransitionsFrom,
  type PostStatus,
  type PostTargetStatus,
} from './repositories/transitions.js';

export {
  createPost,
  createPostInput,
  findPostById,
  isValidIanaTimezone,
  MAX_POST_BODY_BYTES,
  transitionPostStatus,
  transitionPostStatusOrThrow,
  type CreatePostInput,
} from './repositories/posts.js';

export {
  claimPostTargetForPublishing,
  createPostTarget,
  createPostTargetInput,
  DEFAULT_CLAIM_LEASE_MS,
  findPostTargetById,
  incrementAttemptCount,
  reclaimAllStalePostTargets,
  reclaimStalePostTarget,
  recordPublishFailure,
  recordPublishSuccess,
  releasePublishingClaim,
  recordPublishSuccessOrThrow,
  transitionPostTargetStatus,
  transitionPostTargetStatusOrThrow,
  type CreatePostTargetInput,
} from './repositories/post-targets.js';

export {
  createUser,
  createUserInput,
  createWorkspace,
  createWorkspaceInput,
  findWorkspaceForSession,
} from './repositories/workspaces.js';

export {
  deleteEncryptedCredential,
  encryptedRecordInput,
  findEncryptedCredential,
  insertEncryptedCredential,
  listCredentialsNotOnVersion,
  replaceEncryptedCredential,
  type EncryptedRecord,
  type EncryptedRecordInput,
} from './repositories/credentials.js';

export {
  createMediaAssetInput,
  findMediaAssetByChecksum,
  findMediaAssetById,
  insertOrGetMediaAsset,
  setRenditions,
  type CreateMediaAssetInput,
  type MediaAssetRow,
} from './repositories/media-assets.js';

export {
  findConnectionById,
  setConnectionHealth,
  type ConnectionHealth,
  type ConnectionRow,
} from './repositories/connections.js';

export {
  createDeadLetterInput,
  findDeadLettersForTarget,
  writeDeadLetter,
  type CreateDeadLetterInput,
} from './repositories/dead-letters.js';

export {
  auditEventInput,
  writeAuditEvent,
  type AuditEventInput,
} from './repositories/audit-events.js';
