export class EngineError extends Error {
  constructor(public code: "bad_state", message: string) {
    super(message);
    this.name = "EngineError";
  }
}
