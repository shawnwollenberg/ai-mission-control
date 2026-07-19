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
  "Until recently, I led a team of thirteen engineers. Today, I coordinate Codex, Claude Code, Hermes, and other AI agents across terminals and tools. They make me productive, but without a shared plan, status, or accountability, managing them felt like running an invisible engineering organization.",
  "Mission Control is the executive layer for AI agent teams. Give it an objective, and it structures the work, coordinates agents, re-cords evidence, and pauses whenever human judgment is required.",
  "Mission Control is live, open source, and available to try. A new user creates an account, receives a private workspace, and chooses the first agent to connect.",
  "For Codex, Mission Control generates one local command. Mission Agent stores the credential securely, sends a signed heartbeat, and opens a pull channel over outbound HTTPS. It works behind localhost, NAT, and normal firewalls without an inbound tunnel.",
  "After the heartbeat and pull channel are confirmed, the user launches a prefilled mission: analyze this repository. It is reed-only, with explicit constraints and a required Markdown artifact.",
  "Mission Agent pulls and acknowledges the assignment, runs Codex against the approved repository, and reports progress. When analysis finishes, the task and mission complete from durable events—not browser simulation.",
  "This mission produced a genuine, checksummed analysis artifact. The same control model supports implementation work and tested commits. Publication requires separate approval; this real pull request remains open and unmerged.",
  "The operations dashboard restores the visibility I had managing engineers: what is running, what failed, which agents need attention, and what requires my approval.",
  "I built Mission Control with GPT-5.6 and Codex. GPT-5.6 helped shape the product, event-sourced architecture, safety model, and each production phase. Codex audited the prototype, then implemented, tested, deployed, and refined the system—from durable events and real agent execution to onboarding, documentation, and AWS delivery. Humans set direction and remain accountable; agents perform bounded work with visible evidence.",
  "The future is not one assistant doing everything. It is teams of specialized agents working together. Mission Control is the executive layer those teams will need.",
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
          speed: index === 4 ? 1.05 : 0.98,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Scene ${index + 1}: ElevenLabs returned ${response.status}: ${await response.text()}`);
  const file = path.join(outputDir, `scene-${String(index + 1).padStart(2, "0")}.mp3`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  console.log(`Generated ${path.basename(file)}`);
}
