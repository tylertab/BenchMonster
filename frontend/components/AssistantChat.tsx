"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ChatMessage, type ToolCall } from "@/lib/api";
import { useVoice } from "@/lib/useVoice";
import { ResultTable } from "./SqlConsole";
import { Button, Card } from "./ui";

const SUGGESTIONS = [
  "Which model is the best value, and why?",
  "Where do the models disagree most?",
  "Why did the failures happen?",
  "Is the fastest model also the most accurate?",
];

// Minimal markdown: **bold**, `code`, and line breaks. Enough for chat replies.
function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <p key={i} className={line.trim() ? "" : "h-2"}>
          {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) =>
            part.startsWith("**") ? (
              <strong key={j}>{part.slice(2, -2)}</strong>
            ) : part.startsWith("`") ? (
              <code key={j} className="rounded bg-surface-2 px-1 font-mono text-xs">
                {part.slice(1, -1)}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </>
  );
}

function ToolCallView({ call, onOpenSql }: { call: ToolCall; onOpenSql: (sql: string) => void }) {
  const [open, setOpen] = useState(false);
  if (call.tool === "save_finding") {
    return (
      <div className="rounded-md border border-line bg-surface-2/50 px-2.5 py-1.5 text-xs text-ink-2">
        🧠 {call.saved ? "Remembered" : "Couldn't save"}: {call.finding}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line bg-surface-2/50 text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-ink-2 hover:text-ink">
        <span>{open ? "▾" : "▸"}</span>
        <span className="truncate font-mono">{call.sql.replace(/\s+/g, " ")}</span>
        {call.error ? <span className="ml-auto shrink-0 text-critical">✕ error</span> : <span className="ml-auto shrink-0 text-muted">{call.rows?.length ?? 0} rows</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line p-2.5">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono">{call.sql}</pre>
          {call.error ? <p className="text-critical">{call.error}</p> : call.columns && <ResultTable columns={call.columns} rows={call.rows ?? []} />}
          <Button variant="secondary" onClick={() => onOpenSql(call.sql)}>
            Open in SQL console
          </Button>
        </div>
      )}
    </div>
  );
}

export function AssistantChat({
  runId,
  onOpenSql,
  headerActions,
  messages,
  setMessages,
}: {
  runId: number;
  onOpenSql: (sql: string) => void;
  headerActions?: ReactNode;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const voice = useVoice();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatHistory(runId).then(setMessages);
  }, [runId, setMessages]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    setBusy(true);
    const tempId = -Date.now();
    setMessages((m) => [...m, { id: tempId, role: "user", content: text, tool_calls: null }]);
    try {
      const r = await api.chat(runId, text);
      setMessages((m) => [...m, { id: r.id, role: "assistant", content: r.reply, tool_calls: r.tool_calls }]);
      if (speakReplies) voice.speak(r.reply);
    } catch (e) {
      setMessages((m) => [...m, { id: tempId - 1, role: "assistant", content: `⚠️ ${(e as Error).message}`, tool_calls: null }]);
    } finally {
      setBusy(false);
    }
  };

  // Push-to-talk: click to record, click again to send. Voice replies are always spoken.
  const toggleMic = async () => {
    if (voice.state === "speaking") return voice.stopSpeaking();
    if (voice.state !== "recording") return voice.start();
    const clip = await voice.stop();
    if (!clip) return voice.setState("idle");
    setBusy(true);
    try {
      const r = await api.voiceTurn(runId, clip);
      setMessages((m) => [
        ...m,
        { id: -Date.now(), role: "user", content: `🎙️ ${r.transcript}`, tool_calls: null },
        { id: r.id, role: "assistant", content: r.reply, tool_calls: r.tool_calls },
      ]);
      voice.speak(r.reply);
    } catch (e) {
      voice.setError((e as Error).message);
      voice.setState("idle");
    } finally {
      setBusy(false);
    }
  };

  const micLabel = { idle: "Talk", recording: "Stop & send", thinking: "Thinking…", speaking: "Stop speaking" }[voice.state];

  return (
    <Card
      title="AI analyst"
      actions={
        <>
          {headerActions}
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} />
            Speak replies
          </label>
        </>
      }
      className="flex min-w-0 flex-col"
    >
      <div className="flex h-[560px] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <div className="space-y-2 pt-4 text-sm text-ink-2">
              <p>Ask anything about this run. I query the results with SQL and remember key findings across sessions.</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line px-2.5 py-1 text-xs hover:bg-surface-2">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-8 rounded-lg bg-accent px-3 py-2 text-sm text-white">
                {m.content}
              </div>
            ) : (
              <div key={m.id} className="mr-4 space-y-2">
                {m.tool_calls?.map((c, i) => <ToolCallView key={i} call={c} onOpenSql={onOpenSql} />)}
                <div className="space-y-1 text-sm leading-relaxed">
                  <Markdown text={m.content} />
                </div>
              </div>
            ),
          )}
          {busy && <p className="animate-pulse text-sm text-muted">Analyzing…</p>}
          {voice.error && <p className="text-sm text-critical">⚠️ {voice.error}</p>}
          <div ref={bottom} />
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this run…"
            className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            Send
          </Button>
          <Button
            type="button"
            variant={voice.state === "recording" ? "primary" : "secondary"}
            onClick={toggleMic}
            disabled={voice.state === "thinking" || (busy && voice.state !== "speaking")}
            aria-label={micLabel}
            className={voice.state === "recording" ? "animate-pulse !bg-critical" : ""}
          >
            <span aria-hidden>{voice.state === "speaking" ? "🔊" : "🎙️"}</span>
            {micLabel}
          </Button>
        </form>
      </div>
    </Card>
  );
}
