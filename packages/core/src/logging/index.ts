export { createLogger, silentLogger, type CreateLoggerOptions, type Logger } from "./logger.ts";
// `dispose` flushes the LogTape/OTel log sinks on graceful shutdown. Re-exported
// here so the server depends on core's logging surface, not on LogTape directly
// (LogTape is an internal implementation detail per ADR-0009).
export { dispose } from "@logtape/logtape";
