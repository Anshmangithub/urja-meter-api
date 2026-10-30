/** Base class for failures talking to the legacy portal. */
export class PortalError extends Error {}

/** Our credentials were rejected. Retrying will not help. */
export class PortalAuthError extends PortalError {}

/** The portal (or our snapshot) says the requested resource does not exist. */
export class NotFoundError extends PortalError {}

/** Transient: timeouts, 5xx, rate limiting. Safe for the caller to retry later. */
export class PortalUnavailable extends PortalError {
  constructor(
    message: string,
    readonly retryAfterS = 30,
  ) {
    super(message);
  }
}

/** The portal answered in a way we do not understand (it probably changed). */
export class PortalProtocolError extends PortalError {}
