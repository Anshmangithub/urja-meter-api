export class PortalError extends Error {}

export class PortalAuthError extends PortalError {}

export class NotFoundError extends PortalError {}

export class PortalUnavailable extends PortalError {
  constructor(
    message: string,
    readonly retryAfterS = 30,
  ) {
    super(message);
  }
}

export class PortalProtocolError extends PortalError {}
