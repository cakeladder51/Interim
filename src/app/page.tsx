import { listConfigs } from "@/config/load";

export default function Home() {
  const configs = listConfigs();
  const firstConfig = configs[0];
  const styles = firstConfig?.styles ?? [];

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <h1 className="text-4xl font-bold mb-3">Interim</h1>
        <p className="text-lg mb-8" style={{ color: "var(--foreground)" }}>
          Practise Oxbridge-style interviews with an AI interviewer that adapts to your reasoning.
        </p>

        <form
          action="/interview"
          method="get"
          className="rounded-lg border p-6"
          style={{ borderColor: "var(--foreground)", borderWidth: 1 }}
        >
          <fieldset className="mb-6">
            <legend className="text-sm font-semibold mb-3">Subject</legend>
            <div className="flex flex-col gap-2">
              {configs.map((config, index) => (
                <label key={config.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="config"
                    value={config.id}
                    defaultChecked={index === 0}
                    className="w-4 h-4"
                  />
                  <span>{config.subject}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="mb-6">
            <legend className="text-sm font-semibold mb-3">Interviewer style</legend>
            <div className="flex flex-col gap-2">
              {styles.map((style, index) => (
                <label key={style.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="style"
                    value={style.id}
                    defaultChecked={index === 0}
                    className="w-4 h-4"
                  />
                  <span>{style.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            className="w-full py-2 px-4 rounded font-semibold transition-colors"
            style={{
              backgroundColor: "var(--foreground)",
              color: "var(--background)",
            }}
          >
            Start interview
          </button>

          <p className="mt-4 text-sm opacity-60">
            You can choose to record the interview on the next screen.
          </p>
        </form>
      </div>
    </main>
  );
}
