export { connect, type Database, type DatabaseHandle } from './client.js';
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
  transitionPostStatus,
  transitionPostStatusOrThrow,
  type CreatePostInput,
} from './repositories/posts.js';

export {
  createPostTarget,
  createPostTargetInput,
  findPostTargetById,
  incrementAttemptCount,
  recordPublishSuccess,
  transitionPostTargetStatus,
  transitionPostTargetStatusOrThrow,
  type CreatePostTargetInput,
} from './repositories/post-targets.js';

export {
  createUser,
  createUserInput,
  createWorkspace,
  createWorkspaceInput,
  findWorkspaceById,
} from './repositories/workspaces.js';
