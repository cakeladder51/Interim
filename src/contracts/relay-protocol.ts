import { z } from "zod";

// Client -> Relay messages
export const RelayClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string(),
  }),
  z.object({
    type: z.literal("end"),
  }),
]);

export type RelayClientMessage = z.infer<typeof RelayClientMessageSchema>;

// Binary PCM16LE 16 kHz mono frames are also valid client messages
// They are handled as raw binary data, not JSON

// Relay -> Client messages
export const RelayServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
  }),
  z.object({
    type: z.literal("partial"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("turn_start"),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal("turn_complete"),
    turnId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    fatal: z.boolean(),
  }),
]);

export type RelayServerMessage = z.infer<typeof RelayServerMessageSchema>;
