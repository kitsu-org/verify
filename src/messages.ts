export enum MessageTypes {
    Connected = "connected",
    Verify = "verify",
    StripeSession = "stripeSession",
    StripeError = "stripeerror",
    StripeDone = "stripedone",
    VerificationFailed = "verificationFailed",
    VerificationIncomplete = "verificationIncomplete",
    VerificationComplete = "verificationComplete",
}

export interface MessageStructure {
    type: MessageTypes;
    data?: unknown;
}

export interface ConnectedMessage extends MessageStructure {
    type: MessageTypes.Connected;
}

export interface VerifyMessage extends MessageStructure {
    type: MessageTypes.Verify;
}

export interface StripeSessionMessage extends MessageStructure {
    type: MessageTypes.StripeSession;
    data: string;
}

export interface StripeErrorMessage extends MessageStructure {
    type: MessageTypes.StripeError;
    data: { code: string };
}

export interface StripeDoneMessage extends MessageStructure {
    type: MessageTypes.StripeDone;
}

export interface VerificationFailedMessage extends MessageStructure {
    type: MessageTypes.VerificationFailed;
    data: { reason: string };
}

export interface VerificationIncompleteMessage extends MessageStructure {
    type: MessageTypes.VerificationIncomplete;
}

export interface VerificationCompleteMessage extends MessageStructure {
    type: MessageTypes.VerificationComplete;
    data: { verificationId: string };
}

export type WebSocketMessage =
    | ConnectedMessage
    | VerifyMessage
    | StripeSessionMessage
    | StripeErrorMessage
    | StripeDoneMessage
    | VerificationFailedMessage
    | VerificationIncompleteMessage
    | VerificationCompleteMessage;
