"use client";

import { useReducer, useEffect, useRef, useCallback } from "react";
import {
  interviewReducer,
  initialView,
  buildStartRequest,
  buildTurnRequest,
  buildEndRequest,
  buildBackgroundRequest,
  canSend as canSendHelper,
  describeError,
} from "./interview-model";
import type { InterviewAction, InterviewView, BackgroundEvent } from "./interview-model";
import { runStepRequest } from "./step-client";
import { createRequestRunner } from "./request-runner";
import { createBackgroundRunner } from "./background-runner";
import type { Move } from "@/contracts";

/**
 * React hook for managing interview state.
 */
export function useInterview(
  configId: string,
  styleId: string,
  options?: {
    onAction?: (action: InterviewAction) => void;
    onBackgroundSettled?: (move: Move | null) => void;
  }
): {
  view: InterviewView;
  sendTurn: (text: string, source?: "typed" | "voice") => void;
  end: () => void;
  retry: () => void;
  sendBackground: (event: BackgroundEvent) => boolean;
} {
  const [view, dispatch] = useReducer(interviewReducer, initialView);

  // Synchronous view mirror
  const viewRef = useRef<InterviewView>(initialView);

  // Keep ref to latest listeners - sync in effect
  const onActionRef = useRef(options?.onAction);
  const onBgSettledRef = useRef(options?.onBackgroundSettled);
  useEffect(() => {
    onActionRef.current = options?.onAction;
    onBgSettledRef.current = options?.onBackgroundSettled;
  });

  // Create runners once and store in refs
  const runnerRef = useRef<ReturnType<typeof createRequestRunner> | null>(null);
  const bgRef = useRef<ReturnType<typeof createBackgroundRunner> | null>(null);

  // Create runners in effect to avoid accessing refs during render
  useEffect(() => {
    if (runnerRef.current === null) {
      const apply = (action: InterviewAction) => {
        viewRef.current = interviewReducer(viewRef.current, action);
        onActionRef.current?.(action);
        dispatch(action);
      };

      runnerRef.current = createRequestRunner({
        dispatch: apply,
        runStepRequest,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        describeError,
      });

      bgRef.current = createBackgroundRunner({
        dispatch: apply,
        runStepRequest,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        describeError,
        onSettled: (m) => onBgSettledRef.current?.(m),
      });
    }
  }, []);

  // Start on mount
  useEffect(() => {
    const request = buildStartRequest(configId, styleId);
    runnerRef.current?.run(request, null);

    return () => {
      runnerRef.current?.abort();
      bgRef.current?.abort();
    };
  }, [configId, styleId]);

  // Send turn
  const sendTurn = useCallback(
    (text: string, source: "typed" | "voice" = "typed") => {
      if (!canSendHelper(view, text) || !runnerRef.current) {
        return;
      }
      if (!runnerRef.current.inFlight()) {
        const request = buildTurnRequest(view, text, source);
        runnerRef.current.run(request, text);
        bgRef.current?.abort();
      }
    },
    [view]
  );

  // End interview
  const end = useCallback(() => {
    if (
      view.engine === null ||
      view.status !== "ready" ||
      view.engine.phase === "done" ||
      !runnerRef.current
    ) {
      return;
    }
    if (!runnerRef.current.inFlight()) {
      const request = buildEndRequest(view);
      runnerRef.current.run(request, null);
      bgRef.current?.abort();
    }
  }, [view]);

  // Retry last request
  const retry = useCallback(() => {
    if (
      view.status !== "error" ||
      view.error?.retryable !== true ||
      view.lastRequest === null ||
      !runnerRef.current
    ) {
      return;
    }
    if (!runnerRef.current.inFlight()) {
      runnerRef.current.run(view.lastRequest.request, view.lastRequest.studentText);
      bgRef.current?.abort();
    }
  }, [view]);

  // Send background event
  const sendBackground = useCallback((event: BackgroundEvent): boolean => {
    const v = viewRef.current;
    if (
      v.status !== "ready" ||
      v.engine === null ||
      v.engine.phase !== "problem" ||
      runnerRef.current?.inFlight() ||
      !bgRef.current ||
      bgRef.current.inFlight()
    ) {
      return false;
    }
    bgRef.current.run(buildBackgroundRequest(v, event));
    return true;
  }, []);

  return { view, sendTurn, end, retry, sendBackground };
}
