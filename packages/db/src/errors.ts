export class IllegalStatusTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  readonly entity: string;

  constructor(entity: string, from: string, to: string) {
    super(`Illegal ${entity} status transition: ${from} -> ${to}`);
    this.name = 'IllegalStatusTransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

// Thrown when a conditional UPDATE matched zero rows: either another worker won
// the race, or the row was not in the expected state. Callers in ISS-007 treat
// this as "exit cleanly", not as a failure (PRD 3.3 item 2).
export class TransitionRaceLostError extends Error {
  readonly entity: string;
  readonly id: string;
  readonly expectedFrom: string;

  constructor(entity: string, id: string, expectedFrom: string) {
    super(`No ${entity} ${id} in status ${expectedFrom}; another worker likely claimed it`);
    this.name = 'TransitionRaceLostError';
    this.entity = entity;
    this.id = id;
    this.expectedFrom = expectedFrom;
  }
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found in this workspace`);
    this.name = 'NotFoundError';
  }
}
