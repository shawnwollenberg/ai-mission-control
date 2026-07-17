import fs from "node:fs/promises";
import path from "node:path";

const project = path.resolve(import.meta.dirname, "..");
const envPath = path.resolve(project, "../.env");
const envText = await fs.readFile(envPath, "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^['"]|['"]$/g, "")];
    }),
);

const apiKey = env.ELEVENLABS_API_KEY;
const voiceId = env.ELEVENLABS_VOICE_ID || env.voice_id;
if (!apiKey || !voiceId) throw new Error("Missing ElevenLabs API key or voice ID");

const scenes = [
  "Today, AI writes code. Tomorrow, AI will build companies. But AI work still happens everywhere, across disconnected tools, with no single place to understand what your AI organization is doing.",
  "Mission Control changes that. Give your AI organization an objective, and watch the organization assemble itself around the work.",
  "Every objective, assignment, and decision becomes part of a single organizational record. Instead of watching individual agents, you're supervising the organization itself.",
  "Mission Control continuously evaluates the organization's progress. When it detects a better organizational structure, it doesn't simply report the problem. It recommends a safer, faster path forward.",
  "Humans remain responsible for outcomes. Mission Control surfaces the evidence, proposes the change, and asks for judgment only when it matters.",
  "Hermes coordinates execution. Codex performs the work. Every decision. Every artifact. Every outcome. Mission Control records the organization's history.",
  "Every mission ends with a complete executive debrief, connecting organizational decisions to verifiable outcomes.",
  "The future won't be one AI assistant. It will be organizations of AI working together. Mission Control is the executive layer that keeps humans accountable while AI organizations execute.",
  "Mission Control itself was built with Codex powered by GPT-5.6. I used GPT-5.6 inside Codex as a product strategist, systems architect, and lead engineer—turning the initial concept into a product brief, event-sourced architecture, constrained optimizer, implementation plan, tested application, and AWS deployment. Codex also powers the live execution path, where Hermes assigns a bounded implementation task and Mission Control records the resulting lifecycle and artifact events.",
];

const outputDir = path.join(project, "assets/audio/narration");
await fs.mkdir(outputDir, { recursive: true });

const requested = new Set(process.argv.slice(2).map((value) => Number(value)));
for (let index = 0; index < scenes.length; index += 1) {
  if (requested.size && !requested.has(index + 1)) continue;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({
        text: scenes[index],
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.68,
          similarity_boost: 0.78,
          style: 0.08,
          use_speaker_boost: true,
          speed: index === 8 ? 1.08 : 0.94,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Scene ${index + 1}: ElevenLabs returned ${response.status}: ${await response.text()}`);
  const file = path.join(outputDir, `scene-${String(index + 1).padStart(2, "0")}.mp3`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  console.log(`Generated ${path.basename(file)}`);
}
