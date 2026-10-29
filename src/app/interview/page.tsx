import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { listConfigs } from "@/config/load";
import { getPublicConfig } from "@/config/public";
import InterviewGate from "./InterviewGate";
import InterviewSkeleton from "./InterviewSkeleton";

export const metadata: Metadata = {
  title: "Interview · Interim",
};

interface InterviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default function InterviewPage({ searchParams }: InterviewPageProps) {
  return (
    <Suspense fallback={<InterviewSkeleton />}>
      <InterviewLoader searchParams={searchParams} />
    </Suspense>
  );
}

async function InterviewLoader({ searchParams }: InterviewPageProps) {
  const params = await searchParams;
  const configIdRaw = params.config;
  const styleRaw = params.style;

  // Validate params
  const configId =
    typeof configIdRaw === "string" ? configIdRaw : undefined;
  const styleId = typeof styleRaw === "string" ? styleRaw : undefined;

  if (!configId || !styleId) {
    return <ErrorCard message="That interview setup doesn't exist." />;
  }

  // Check if config exists
  const configs = listConfigs();
  const configInfo = configs.find((c) => c.id === configId);
  if (!configInfo) {
    return <ErrorCard message="That interview setup doesn't exist." />;
  }

  // Check if style exists for this config
  const styleInfo = configInfo.styles.find((s) => s.id === styleId);
  if (!styleInfo) {
    return <ErrorCard message="That interview setup doesn't exist." />;
  }

  // Get public config
  const publicConfig = getPublicConfig(configId);

  return <InterviewGate config={publicConfig} styleId={styleId} />;
}

function ErrorCard({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="rounded-lg border p-6 max-w-md w-full text-center">
        <p className="mb-4">{message}</p>
        <Link
          href="/"
          className="inline-block py-2 px-4 rounded font-semibold"
          style={{
            backgroundColor: "var(--foreground)",
            color: "var(--background)",
          }}
        >
          Back to start
        </Link>
      </div>
    </main>
  );
}
