// Spec 16.3 asks for Ink so the lane view, bottleneck highlighting and priority list
// render as real components rather than print statements, and so the tool shares a
// mental model with the web client.
//
// Everything of substance lives in commands.ts as pure functions; this file only
// reads a line, calls runCommand, and appends the output.
import React, { useState } from "react";
import { Box, Static, Text, render, useApp } from "ink";
import TextInput from "ink-text-input";
import { loadContent } from "./bootstrap.js";
import { HELP, newSession, renderStatus, runCommand, type Session } from "./commands.js";

interface Line {
  key: string;
  text: string;
}

function App({ initial }: { initial: Session }): React.JSX.Element {
  const { exit } = useApp();
  const [session, setSession] = useState(initial);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    ["Manufactory Idle — sim play. Type help.", ...HELP.slice(0, 3)].map((text, i) => ({
      key: `boot-${i}`,
      text,
    })),
  );

  const submit = (value: string): void => {
    const result = runCommand(session, value);
    const stamp = Date.now();
    setLines((current) => [
      ...current,
      { key: `in-${stamp}`, text: `> ${value}` },
      ...result.output.map((text, i) => ({ key: `out-${stamp}-${i}`, text })),
    ]);
    setSession(result.session);
    setInput("");
    if (result.quit) exit();
  };

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line) => <Text key={line.key}>{line.text}</Text>}</Static>
      <Box flexDirection="column" marginTop={1}>
        {renderStatus(session).map((text, i) => (
          <Text key={`status-${i}`} dimColor={i > 0}>
            {text}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}

export async function startPlay(options: { contentDir?: string; seed: number }): Promise<void> {
  const content = loadContent(options.contentDir);
  const instance = render(<App initial={newSession(content, options.seed)} />);
  await instance.waitUntilExit();
}
