"use client";

import { useEffect, useRef, useCallback } from "react";

interface ScratchpadProps {
  onChange: (getImage: () => string | null) => void;
  onActivity: () => void;
  disabled: boolean;
}

export default function Scratchpad({ onChange, onActivity, disabled }: ScratchpadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasInkRef = useRef(false);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const drewRef = useRef(false);

  // Fill white on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Get image function
  const getImage = useCallback((): string | null => {
    if (!hasInkRef.current) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  }, []);

  // Pointer handlers
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    drewRef.current = false;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    lastPointRef.current = { x: x * scaleX, y: y * scaleY };

    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111";

    onActivity();
  }, [disabled, onActivity]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const currentPoint = { x: x * scaleX, y: y * scaleY };
    const last = lastPointRef.current;

    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(currentPoint.x, currentPoint.y);
      ctx.stroke();
      drewRef.current = true;
    }

    lastPointRef.current = currentPoint;
  }, []);

  const handlePointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }
    drawingRef.current = false;
    lastPointRef.current = null;

    // If we drew at least one segment, set hasInk and call onChange
    if (drewRef.current) {
      drewRef.current = false;
      hasInkRef.current = true;
      onChange(getImage);
    }
  }, [getImage, onChange]);

  // Clear
  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    onActivity();
  }, [onActivity]);

  return (
    <div>
      <h3 className="text-sm font-semibold mb-1 opacity-60">Scratchpad</h3>
      <p className="text-sm opacity-60 mb-2">
        Draw your working here. The interviewer looks at it when you pause.
      </p>
      <canvas
        ref={canvasRef}
        width={800}
        height={500}
        aria-label="Scratchpad for your working"
        style={{
          width: "100%",
          touchAction: "none",
          border: "1px solid var(--foreground)",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
      />
      <div className="mt-2">
        <button
          onClick={handleClear}
          disabled={disabled}
          className="px-3 py-1 rounded text-sm"
          style={{
            backgroundColor: disabled ? "rgba(128, 128, 128, 0.2)" : "var(--foreground)",
            color: "var(--background)",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
