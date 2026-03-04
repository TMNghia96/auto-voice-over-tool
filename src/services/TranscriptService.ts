import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getWhisperPath, getWhisperModelPath, getFfmpegPath, isWhisperEngineReady, downloadWhisperEngine } from './EnvironmentService';
import { optimizeSrtFile } from '../lib/SrtOptimizer';

export type TranscriptEngine = 'whisper-cpu' | 'whisper-gpu' | 'whisper-vulkan' | 'assemblyai';

interface TranscriptProgress {
    status: 'preparing' | 'converting' | 'transcribing' | 'downloading' | 'done' | 'error';
    progress: number; // 0-100
    detail: string;
}

type ProgressCallback = (progress: TranscriptProgress) => void;

/**
 * Convert audio file (mp3/m4a/etc.) to 16kHz mono WAV using ffmpeg
 * whisper.cpp requires WAV 16kHz mono input
 */
const convertToWav = (inputPath: string, outputPath: string, ffmpegPath: string): Promise<boolean> => {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
            '-i', inputPath,
            '-ar', '16000',    // 16kHz sample rate
            '-ac', '1',        // mono
            '-c:a', 'pcm_s16le', // 16-bit PCM
            '-y',              // overwrite
            outputPath
        ]);

        proc.stderr.on('data', (data) => {
            console.log('[ffmpeg convert]', data.toString());
        });

        proc.on('close', (code) => {
            resolve(code === 0);
        });

        proc.on('error', (err) => {
            console.error('ffmpeg convert error:', err);
            resolve(false);
        });
    });
};

/**
 * Run whisper.cpp to transcribe audio and generate SRT
 */
const runWhisper = (
    wavPath: string,
    outputDir: string,
    outputName: string,
    onProgress: ProgressCallback,
    engine: 'cpu' | 'gpu' | 'vulkan' = 'cpu',
    language = 'auto'
): Promise<string | null> => {
    return new Promise((resolve) => {
        const whisperPath = getWhisperPath(engine);
        const modelPath = getWhisperModelPath();

        const outputBase = path.join(outputDir, outputName);

        const args = [
            '-m', modelPath,
            '-f', wavPath,
            '-osrt',                // Output SRT format
            '-of', outputBase,      // Output file base name (whisper adds .srt)
            '-l', language || 'auto',
            '--print-progress',     // Print progress
        ];

        console.log('Running whisper:', whisperPath, args.join(' '));

        const proc = spawn(whisperPath, args, {
            cwd: path.dirname(whisperPath)
        });

        let lastProgress = 0;

        let stderrOutput = '';
        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderrOutput += text;
            console.log('[whisper stderr]', text);

            const progressMatch = text.match(/progress\s*=\s*(\d+)%/);
            if (progressMatch) {
                const pct = parseInt(progressMatch[1], 10);
                if (pct > lastProgress) {
                    lastProgress = pct;
                    onProgress({
                        status: 'transcribing',
                        progress: 30 + pct * 0.7, // 30-100% range
                        detail: `Transcribing voice... ${pct}%`
                    });
                }
            }
        });

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            console.log('[whisper stdout]', text);

            const progressMatch = text.match(/progress\s*=\s*(\d+)%/);
            if (progressMatch) {
                const pct = parseInt(progressMatch[1], 10);
                if (pct > lastProgress) {
                    lastProgress = pct;
                    onProgress({
                        status: 'transcribing',
                        progress: 30 + pct * 0.7,
                        detail: `Transcribing voice... ${pct}%`
                    });
                }
            }
        });

        proc.on('close', (code) => {
            console.log('Whisper finished, exit code:', code);
            const srtPath = outputBase + '.srt';
            if (code === 0 && fs.existsSync(srtPath)) {
                resolve(srtPath);
            } else {
                if (code === 3221225781) {
                    onProgress({
                        status: 'error',
                        progress: 0,
                        detail: 'Whisper failed with a memory access error (0xC0000005).\n\n' +
                            'This is likely due to missing MinGW DLLs or incompatible GPU drivers. Please try:\n' +
                            '1. Updating your AMD Graphics Drivers to the latest version.\n' +
                            '2. Switching to a smaller model (e.g., "base" or "small") in the Models tab.\n' +
                            '3. Clicking "Re-install" in the Recognition tab to re-verify the engine binaries.\n' +
                            '4. If you have an NVIDIA GPU, specifically select the "GPU (CUDA)" engine instead.'
                    });
                    resolve(null);
                    return;
                }

                let errorMessage = `Whisper failed (Exit code: ${code}).`;
                if (code === 1) {
                    errorMessage = 'Parameter or model file error. Check if the model is downloaded.';
                }

                console.error('Whisper failed.', errorMessage, 'Stderr:', stderrOutput);
                onProgress({ status: 'error', progress: 0, detail: errorMessage });
                resolve(null);
            }
        });

        proc.on('error', (err) => {
            console.error('Whisper spawn error:', err);
            onProgress({ status: 'error', progress: 0, detail: `Could not start Whisper: ${err.message}` });
            resolve(null);
        });
    });
};

/**
 * Find the audio file in the project's original/audio directory
 */
const findAudioFile = (projectPath: string): string | null => {
    const audioDir = path.join(projectPath, 'original', 'audio');
    if (!fs.existsSync(audioDir)) return null;

    const files = fs.readdirSync(audioDir);
    const audioFile = files.find(f =>
        f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav') ||
        f.endsWith('.opus') || f.endsWith('.ogg') || f.endsWith('.webm')
    );

    if (audioFile) {
        return path.join(audioDir, audioFile);
    }
    return null;
};

/**
 * Main transcription function:
 * 1. Check and download whisper engine if needed
 * 2. Find audio file in project
 * 3. Convert to WAV (16kHz mono)
 * 4. Run whisper.cpp to generate SRT
 * 5. Return SRT content
 */
export const transcribeAudio = async (
    projectPath: string,
    onProgress: ProgressCallback,
    engine: TranscriptEngine = 'whisper-cpu',
    language = 'auto'
): Promise<{ srtPath: string; srtContent: string } | null> => {
    try {
        if (engine === 'assemblyai') {
            onProgress({ status: 'error', progress: 0, detail: 'AssemblyAI chưa được hỗ trợ. Vui lòng chọn Whisper.' });
            return null;
        }

        const whisperVariant: 'cpu' | 'gpu' | 'vulkan' =
            engine === 'whisper-gpu' ? 'gpu' :
                engine === 'whisper-vulkan' ? 'vulkan' : 'cpu';

        console.log(`Transcript engine requested: ${engine}, using variant: ${whisperVariant}`);

        if (!isWhisperEngineReady(whisperVariant)) {
            const engineLabel = whisperVariant === 'gpu' ? 'GPU (CUDA)'
                : whisperVariant === 'vulkan' ? 'GPU (Vulkan - AMD/Intel/NVIDIA)'
                    : 'CPU';
            onProgress({ status: 'downloading', progress: 0, detail: `Downloading Whisper (${engineLabel})...` });
            const downloaded = await downloadWhisperEngine(whisperVariant, (p) => {
                onProgress({
                    status: 'downloading',
                    progress: p.progress * 0.15, // Map 0-100 → 0-15
                    detail: p.detail
                });
            });
            if (!downloaded) {
                onProgress({ status: 'error', progress: 0, detail: 'Failed to download Whisper engine!' });
                return null;
            }
        }

        onProgress({ status: 'preparing', progress: 15, detail: 'Finding audio file...' });
        const audioFile = findAudioFile(projectPath);
        if (!audioFile) {
            onProgress({ status: 'error', progress: 0, detail: 'Audio file not found in project!' });
            return null;
        }
        console.log('Found audio file:', audioFile);
        onProgress({ status: 'preparing', progress: 18, detail: `Found: ${path.basename(audioFile)}` });

        const transcriptDir = path.join(projectPath, 'transcript');
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }

        const wavPath = path.join(transcriptDir, 'audio_16k.wav');

        if (!fs.existsSync(wavPath)) {
            onProgress({ status: 'converting', progress: 20, detail: 'Converting audio to WAV...' });
            const ffmpegPath = getFfmpegPath();
            const converted = await convertToWav(audioFile, wavPath, ffmpegPath);
            if (!converted) {
                onProgress({ status: 'error', progress: 20, detail: 'Audio conversion failed!' });
                return null;
            }
        }

        onProgress({ status: 'converting', progress: 30, detail: 'Audio conversion complete!' });

        onProgress({ status: 'transcribing', progress: 30, detail: 'Starting voice recognition...' });

        console.log(`Starting Whisper transcription with variant: ${whisperVariant} and path: ${getWhisperPath(whisperVariant)}`);
        const videoId = path.basename(audioFile, path.extname(audioFile));
        const srtPath = await runWhisper(wavPath, transcriptDir, videoId, onProgress, whisperVariant, language);

        if (!srtPath) {
            onProgress({ status: 'error', progress: 0, detail: 'Voice recognition failed!' });
            return null;
        }

        onProgress({ status: 'transcribing', progress: 95, detail: 'Optimizing subtitles...' });
        const srtContent = optimizeSrtFile(srtPath);
        console.log('SRT optimized:', srtPath);

        onProgress({ status: 'done', progress: 100, detail: 'Voice recognition complete!' });

        return { srtPath, srtContent };

    } catch (error) {
        console.error('Transcription failed:', error);
        onProgress({ status: 'error', progress: 0, detail: `Error: ${error}` });
        return null;
    }
};

/**
 * Read existing SRT file if already transcribed
 */
export const getExistingSrt = (projectPath: string): { srtPath: string; srtContent: string } | null => {
    const transcriptDir = path.join(projectPath, 'transcript');
    if (!fs.existsSync(transcriptDir)) return null;

    const files = fs.readdirSync(transcriptDir);
    const srtFile = files.find(f => f.endsWith('.srt'));

    if (srtFile) {
        const srtPath = path.join(transcriptDir, srtFile);
        const srtContent = fs.readFileSync(srtPath, 'utf-8');
        return { srtPath, srtContent };
    }

    return null;
};
