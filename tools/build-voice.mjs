// Génère les annonces vocales du site : audio/voice.wav (toutes les phrases bout à bout) et
// audio/voice.json (position de chaque phrase).
//
// Les phrases sont lues dans le code du site (js/analyzer.js et js/feedback.js) : après en avoir
// modifié une, relancer ce script. Il utilise la voix française de Windows (« Microsoft Hortense
// Desktop ») et ne fonctionne donc que sous Windows :
//
//     node tools/build-voice.mjs
//
// Pourquoi des fichiers et non la synthèse vocale du navigateur : sur iPhone, Safari met en pause
// la vidéo de la caméra dès qu'un site appelle speechSynthesis. Des sons joués par Web Audio
// n'ont pas cet effet, et fonctionnent hors connexion.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BANDS, SECTORS, Level, alertMessage } from '../js/analyzer.js';
import { PHRASES } from '../js/feedback.js';

const VOICE = 'Microsoft Hortense Desktop';
const SAMPLE_RATE = 22050;
/** Silence entre deux phrases : évite qu'une lecture déborde sur la suivante. */
const GAP_SECONDS = 0.2;
/** En dessous de cette amplitude (sur 32768), un échantillon compte comme du silence. */
const SILENCE_THRESHOLD = 180;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(root, 'audio');

function collectPhrases() {
  const phrases = new Set(Object.values(PHRASES));
  // Seuls les dangers « proche » et « très proche » sont annoncés.
  for (const level of [Level.WARNING, Level.CRITICAL]) {
    for (const band of BANDS) {
      for (const sector of SECTORS) phrases.add(alertMessage({ band, sector, level }));
    }
  }
  return [...phrases];
}

function synthesize(phrases, directory) {
  const listPath = path.join(directory, 'phrases.json');
  writeFileSync(listPath, JSON.stringify(phrases), 'utf8');
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Speech
    $phrases = [System.IO.File]::ReadAllText('${listPath}', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voice.SelectVoice('${VOICE}')
    $voice.Rate = 2
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    for ($i = 0; $i -lt $phrases.Count; $i++) {
      $voice.SetOutputToWaveFile((Join-Path '${directory}' ("$i.wav")), $format)
      $voice.Speak([string]$phrases[$i])
    }
    $voice.SetOutputToNull()
    $voice.Dispose()
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`La synthèse vocale a échoué :\n${result.stderr || result.stdout}`);
  }
}

/** Extrait les échantillons 16 bits d'un fichier WAV PCM mono. */
function readSamples(file) {
  const bytes = readFileSync(file);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const end = Math.min(offset + 8 + size, bytes.length);
      const samples = new Int16Array((end - offset - 8) >> 1);
      for (let index = 0; index < samples.length; index++) {
        samples[index] = bytes.readInt16LE(offset + 8 + index * 2);
      }
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`Bloc de données introuvable dans ${file}`);
}

/** Retire le silence de début et de fin, en gardant une courte marge. */
function trim(samples) {
  const margin = Math.round(SAMPLE_RATE * 0.02);
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < SILENCE_THRESHOLD) start++;
  while (end > start && Math.abs(samples[end - 1]) < SILENCE_THRESHOLD) end--;
  return samples.subarray(Math.max(0, start - margin), Math.min(samples.length, end + margin));
}

function writeWave(file, samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16); // taille du bloc de format
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // octets par seconde
  header.writeUInt16LE(2, 32); // octets par échantillon
  header.writeUInt16LE(16, 34); // bits par échantillon
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) body.writeInt16LE(samples[index], index * 2);
  writeFileSync(file, Buffer.concat([header, body]));
}

const phrases = collectPhrases();
const workDirectory = mkdtempSync(path.join(tmpdir(), 'aveuglator-voice-'));
try {
  synthesize(phrases, workDirectory);

  const gap = Math.round(SAMPLE_RATE * GAP_SECONDS);
  const parts = phrases.map((_, index) => trim(readSamples(path.join(workDirectory, `${index}.wav`))));
  const total = parts.reduce((sum, part) => sum + part.length + gap, gap);
  const sprite = new Int16Array(total);
  const clips = {};
  let cursor = gap;
  parts.forEach((part, index) => {
    if (part.length === 0) throw new Error(`Phrase muette : « ${phrases[index]} »`);
    sprite.set(part, cursor);
    // [début, durée] en secondes.
    clips[phrases[index]] = [
      Number((cursor / SAMPLE_RATE).toFixed(4)),
      Number((part.length / SAMPLE_RATE).toFixed(4)),
    ];
    cursor += part.length + gap;
  });

  mkdirSync(outputDirectory, { recursive: true });
  writeWave(path.join(outputDirectory, 'voice.wav'), sprite);
  writeFileSync(
    path.join(outputDirectory, 'voice.json'),
    `${JSON.stringify({ voice: VOICE, sampleRate: SAMPLE_RATE, clips }, null, 2)}\n`,
    'utf8',
  );
  console.log(`${phrases.length} phrases, ${(total / SAMPLE_RATE).toFixed(1)} s, ${((44 + total * 2) / 1e6).toFixed(2)} Mo`);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
