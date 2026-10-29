export const MAX_CHUNK_CHARS = 200;

export function createSentenceChunker(): {
  push(text: string): string[];
  flush(): string | null;
  reset(): void;
} {
  let buffer = "";

  function processBuffer(): string[] {
    const chunks: string[] = [];

    while (buffer.length > 0) {
      // Step 1: Find sentence boundary
      const match = buffer.match(/[.?!]+["')\]]*\s+|\n+/);
      if (match && match.index !== undefined) {
        const endIdx = match.index + match[0].length;
        const chunk = buffer.slice(0, endIdx).trim();
        buffer = buffer.slice(endIdx);
        if (chunk.length > 0) {
          chunks.push(chunk);
        }
        continue;
      }

      // Step 2: Check for long chunk
      if (buffer.length > MAX_CHUNK_CHARS) {
        let cut = buffer.lastIndexOf(" ", MAX_CHUNK_CHARS);
        if (cut <= 0) {
          cut = MAX_CHUNK_CHARS;
        }
        const chunk = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut);
        if (chunk.length > 0) {
          chunks.push(chunk);
        }
        continue;
      }

      // Step 3: Stop
      break;
    }

    return chunks;
  }

  return {
    push(text: string): string[] {
      buffer += text;
      return processBuffer();
    },

    flush(): string | null {
      const result = buffer.trim();
      buffer = "";
      return result.length > 0 ? result : null;
    },

    reset(): void {
      buffer = "";
    },
  };
}
