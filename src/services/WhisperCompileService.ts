/**
 * WhisperCompileService - Auto-compile whisper.cpp with Vulkan support
 * Ported from easy-whisper-ui's CompileManager
 * 
 * Pipeline:
 *   1. Ensure MSYS2 toolchain
 *   2. Install MinGW packages (gcc, cmake, ninja, SDL2)
 *   3. Check/install Vulkan SDK
 *   4. Fetch whisper.cpp source
 *   5. Configure CMake with GGML_VULKAN=1
 *   6. Build whisper-cli
 *   7. Copy binary + DLLs to bin/whisper-vulkan/
 */

import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';

const WORK_ROOT_NAME = 'whisper-workspace';

export const REQUIRED_DLLS = [
    'libwinpthread-1.dll',
    'libstdc++-6.dll',
    'libgcc_s_seh-1.dll',
    'SDL2.dll',
];

export interface CompileProgressEvent {
    step: string;
    message: string;
    progress: number;    // 0-100
    state: 'running' | 'success' | 'error';
    error?: string;
}

interface ToolchainContext {
    workRoot: string;
    toolchainRoot: string;
    downloadsDir: string;
    msysRoot: string;
    mingwBin: string;
    usrBin: string;
    cmakePath: string;
    bashPath: string;
    gccPath: string;
    gxxPath: string;
    arPath: string;
    ranlibPath: string;
    sdl2CMakeDir: string;
    vulkanSdkPath?: string;
    env: NodeJS.ProcessEnv;
}

export class WhisperCompileService extends EventEmitter {
    private running = false;
    private logStream?: fs.WriteStream;

    /**
     * Main compile entry point.
     * Returns the path to the output bin directory containing whisper-cli.exe
     */
    async compile(outputDir: string, force = false): Promise<{ success: boolean; error?: string }> {
        if (this.running) {
            return { success: false, error: 'Compilation already in progress.' };
        }

        this.running = true;
        const workRoot = await this.ensureWorkDirs();
        await this.startLog(workRoot);
        const binDir = path.join(workRoot, 'bin');

        try {
            // Check cache
            if (!force && this.hasBinaries(binDir)) {
                // Copy cached binaries to output
                await this.copyToOutput(binDir, outputDir);
                this.emitProgress({ step: 'check-cache', message: 'Ready (from cache).', progress: 100, state: 'success' });
                this.running = false;
                return { success: true };
            }

            // Step 1: Prepare toolchain context
            await this.runStep('prepare', 'Preparing workspace...', 5, async () => {
                await fsp.mkdir(binDir, { recursive: true });
            });

            const toolchain = await this.prepareToolchain(workRoot, force);

            // Step 2: Ensure MSYS2
            await this.runStep('msys', 'Installing MSYS2 toolchain...', 15, async () => {
                await this.ensureMsys(toolchain);
            });

            // Step 3: Install packages
            await this.runStep('packages', 'Installing packages (gcc, cmake, ninja)...', 25, async () => {
                await this.installPackages(toolchain);
            });

            // Step 4: Check Vulkan SDK
            await this.runStep('vulkan', 'Checking Vulkan SDK...', 30, async () => {
                if (!toolchain.vulkanSdkPath) {
                    this.emitConsole('[vulkan] Vulkan SDK not found. Attempting to install with winget...');
                    await this.installVulkanSdk();
                    toolchain.vulkanSdkPath = this.resolveVulkanSdkPath() ?? undefined;
                    if (toolchain.vulkanSdkPath) {
                        // Update env with new Vulkan SDK path
                        toolchain.env.VULKAN_SDK = toolchain.vulkanSdkPath;
                    }
                }
                if (!toolchain.vulkanSdkPath) {
                    this.emitConsole('[vulkan] Vulkan SDK not found. Build will proceed without Vulkan acceleration.');
                }
            });

            // Step 5: Fetch whisper.cpp source
            const sourceDir = path.join(workRoot, 'whisper.cpp');
            await this.runStep('source', 'Downloading whisper.cpp source code...', 40, async () => {
                await this.ensureWhisperSource(sourceDir, force);
            });

            // Step 6: Configure CMake
            await this.runStep('configure', 'Configuring CMake...', 55, async () => {
                await this.configureWithCmake(toolchain, sourceDir);
            });

            // Step 7: Build
            await this.runStep('build', 'Compiling whisper-cli (may take 5-10 minutes)...', 85, async () => {
                await this.buildBinaries(toolchain, sourceDir);
            });

            // Step 8: Copy artifacts
            await this.runStep('copy', 'Copying binaries...', 95, async () => {
                await this.copyArtifacts(toolchain, sourceDir, binDir);
                await this.copyToOutput(binDir, outputDir);
            });

            // Step 9: Verify
            await this.runStep('verify', 'Verifying the newly compiled binary...', 98, async () => {
                const isValid = await this.verifyBinary(outputDir);
                if (!isValid) {
                    throw new Error('Compiled binary failed to run (missing DLL or memory error).');
                }
            });

            this.emitProgress({ step: 'completed', message: 'Compilation successful!', progress: 100, state: 'success' });
            this.running = false;
            return { success: true };
        } catch (error) {
            const err = error as Error;
            this.emitProgress({ step: 'failed', message: 'Compilation failed.', progress: 100, state: 'error', error: err.message });
            this.running = false;
            return { success: false, error: err.message };
        } finally {
            this.stopLog();
        }
    }

    isRunning(): boolean {
        return this.running;
    }

    // --- Private Methods ---

    private async runStep(step: string, message: string, targetProgress: number, action: () => Promise<void>): Promise<void> {
        this.emitProgress({ step, message, progress: targetProgress, state: 'running' });
        this.emitConsole(`[${step}] ${message}`);
        await action();
        this.emitProgress({ step, message, progress: targetProgress, state: 'success' });
    }

    private emitProgress(event: CompileProgressEvent): void {
        this.emit('progress', event);
    }

    private emitConsole(message: string): void {
        this.emit('console', { source: 'compile', message });
    }

    private async startLog(workRoot: string): Promise<void> {
        const logPath = path.join(workRoot, 'compile-log.txt');
        try { await fsp.rm(logPath, { force: true }); } catch { /* ignore */ }
        this.logStream = fs.createWriteStream(logPath, { flags: 'w' });
    }

    private stopLog(): void {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = undefined;
        }
    }

    private writeLog(data: string | Buffer): void {
        if (this.logStream) {
            this.logStream.write(data);
        }
    }

    private async ensureWorkDirs(): Promise<string> {
        const root = path.join(app.getPath('userData'), WORK_ROOT_NAME);
        await fsp.mkdir(root, { recursive: true });
        return root;
    }

    private hasBinaries(binDir: string): boolean {
        if (!fs.existsSync(binDir)) return false;
        return fs.existsSync(path.join(binDir, 'whisper-cli.exe'));
    }

    private async copyToOutput(srcBinDir: string, destDir: string): Promise<void> {
        await fsp.mkdir(destDir, { recursive: true });
        const files = await fsp.readdir(srcBinDir);
        for (const file of files) {
            const src = path.join(srcBinDir, file);
            const dest = path.join(destDir, file);
            const stat = await fsp.stat(src);
            if (stat.isFile()) {
                await fsp.copyFile(src, dest);
            }
        }
    }

    private async verifyBinary(binDir: string): Promise<boolean> {
        return new Promise((resolve) => {
            const exePath = path.join(binDir, 'whisper-cli.exe');
            if (!fs.existsSync(exePath)) return resolve(false);

            this.emitConsole(`[verify] Running trial: ${exePath} --help`);
            const proc = spawn(exePath, ['--help'], {
                cwd: binDir,
                env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
            });

            let output = '';
            proc.stdout.on('data', (d) => output += d.toString());
            proc.stderr.on('data', (d) => output += d.toString());

            const timeout = setTimeout(() => {
                proc.kill();
                this.emitConsole('[verify] Verification timed out.');
                resolve(false);
            }, 10000);

            proc.on('close', (code) => {
                clearTimeout(timeout);
                this.emitConsole(`[verify] Exit code: ${code}`);
                if (code === 0 || output.toLowerCase().includes('usage:')) {
                    this.emitConsole('[verify] Binary is working correctly.');
                    resolve(true);
                } else {
                    this.emitConsole(`[verify] Lỗi: ${output}`);
                    resolve(false);
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                this.emitConsole(`[verify] Could not start: ${err.message}`);
                resolve(false);
            });
        });
    }

    private resolveVulkanSdkPath(): string | null {
        const envPath = process.env.VULKAN_SDK;
        if (envPath && fs.existsSync(envPath)) {
            return envPath;
        }

        // Check registry
        try {
            const reg = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Khronos\\Vulkan\\RT', '/v', 'VulkanSDK'], { encoding: 'utf8' });
            if (reg.status === 0 && reg.stdout) {
                const line = reg.stdout
                    .split(/\r?\n/)
                    .map((v) => v.trim())
                    .find((v) => v.startsWith('VulkanSDK'));
                if (line) {
                    const parts = line.split(/\s{2,}|\t+/).filter(Boolean);
                    const candidate = parts[parts.length - 1];
                    if (candidate && fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            }
        } catch { /* ignore */ }

        // Check default install path
        const defaultRoot = 'C:/VulkanSDK';
        if (fs.existsSync(defaultRoot)) {
            try {
                const entries = fs.readdirSync(defaultRoot, { withFileTypes: true })
                    .filter((d) => d.isDirectory())
                    .map((d) => d.name)
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
                for (const entry of entries) {
                    const candidate = path.join(defaultRoot, entry);
                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            } catch { /* ignore */ }
        }

        return null;
    }

    private async installVulkanSdk(): Promise<void> {
        const script = [
            'winget source update --name winget | Out-Null',
            'winget install --id KhronosGroup.VulkanSDK --source winget -e --accept-source-agreements --accept-package-agreements',
        ].join('; ');

        try {
            await this.runPowerShell(script, 'VulkanSDK');
        } catch (err) {
            this.emitConsole(`[vulkan] Could not install Vulkan SDK automatically: ${err}`);
        }
    }

    private async prepareToolchain(workRoot: string, force: boolean): Promise<ToolchainContext> {
        const toolchainRoot = path.join(workRoot, 'toolchain');
        const downloadsDir = path.join(workRoot, 'downloads');

        if (force) {
            await fsp.rm(toolchainRoot, { recursive: true, force: true });
        }

        await fsp.mkdir(toolchainRoot, { recursive: true });
        await fsp.mkdir(downloadsDir, { recursive: true });

        const msysRoot = path.join(toolchainRoot, 'msys64');
        const mingwBin = path.join(msysRoot, 'mingw64', 'bin');
        const usrBin = path.join(msysRoot, 'usr', 'bin');

        // Build PATH: mingwBin + usrBin first, then filter conflicting paths
        const originalPath = process.env.PATH ?? '';
        const filteredEntries = originalPath
            .split(path.delimiter)
            .filter((entry) => entry && !entry.toLowerCase().includes('\\miniconda3\\library\\mingw-w64\\bin'));

        const normalizedMingw = mingwBin.replace(/\\/g, '/').toLowerCase();
        const normalizedUsr = usrBin.replace(/\\/g, '/').toLowerCase();
        const sanitizedEntries = filteredEntries.filter((entry) => {
            const normalized = entry.replace(/\\/g, '/').toLowerCase();
            return normalized !== normalizedMingw && normalized !== normalizedUsr;
        });

        const pathEntries = [mingwBin, usrBin];
        const vulkanSdkPathResolved = this.resolveVulkanSdkPath() ?? undefined;
        if (vulkanSdkPathResolved) {
            pathEntries.unshift(path.join(vulkanSdkPathResolved, 'Bin'));
        }
        pathEntries.push(...sanitizedEntries.filter(Boolean));
        const uniqueEntries = Array.from(new Set(pathEntries.filter(Boolean)));
        const envPath = uniqueEntries.join(path.delimiter);

        const gccPath = path.join(mingwBin, 'gcc.exe');
        const gxxPath = path.join(mingwBin, 'g++.exe');
        const preferredAr = path.join(mingwBin, 'gcc-ar.exe');
        const preferredRanlib = path.join(mingwBin, 'gcc-ranlib.exe');
        const fallbackAr = path.join(mingwBin, 'ar.exe');
        const fallbackRanlib = path.join(mingwBin, 'ranlib.exe');
        const arPath = fs.existsSync(preferredAr) ? preferredAr : fallbackAr;
        const ranlibPath = fs.existsSync(preferredRanlib) ? preferredRanlib : fallbackRanlib;

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: envPath,
            CC: gccPath,
            CXX: gxxPath,
            AR: arPath,
            RANLIB: ranlibPath,
            MSYSTEM: 'MINGW64',
            CHERE_INVOKING: '1',
        };

        if (vulkanSdkPathResolved) {
            env.VULKAN_SDK = vulkanSdkPathResolved;
        }

        return {
            workRoot,
            toolchainRoot,
            downloadsDir,
            msysRoot,
            mingwBin,
            usrBin,
            cmakePath: path.join(mingwBin, 'cmake.exe'),
            bashPath: path.join(usrBin, 'bash.exe'),
            gccPath,
            gxxPath,
            arPath,
            ranlibPath,
            sdl2CMakeDir: path.join(msysRoot, 'mingw64', 'lib', 'cmake', 'SDL2'),
            vulkanSdkPath: vulkanSdkPathResolved,
            env,
        };
    }

    private toPosixPath(value: string): string {
        return value.replace(/\\/g, '/');
    }

    private async ensureMsys(context: ToolchainContext): Promise<void> {
        if (fs.existsSync(context.cmakePath)) {
            this.emitConsole('[msys] MSYS2 is already available.');
            return;
        }

        const script = [
            `$toolchainRoot = '${this.toPosixPath(context.toolchainRoot)}'`,
            `$downloads = '${this.toPosixPath(context.downloadsDir)}'`,
            "New-Item -ItemType Directory -Path $toolchainRoot -Force | Out-Null",
            "New-Item -ItemType Directory -Path $downloads -Force | Out-Null",
            "$msysRoot = Join-Path $toolchainRoot 'msys64'",
            "if (Test-Path $msysRoot) { Remove-Item $msysRoot -Recurse -Force }",
            "$msysUrl = 'https://github.com/msys2/msys2-installer/releases/latest/download/msys2-base-x86_64-latest.sfx.exe'",
            "$msysTmp = Join-Path $downloads 'msys2-installer.exe'",
            "if (Test-Path $msysTmp) { Remove-Item $msysTmp -Force }",
            "Invoke-WebRequest -Uri $msysUrl -OutFile $msysTmp -UseBasicParsing",
            "$args = @('-y', \"-o`\"$toolchainRoot`\"\")",
            "Start-Process -FilePath $msysTmp -ArgumentList $args -Wait -NoNewWindow",
            "Remove-Item $msysTmp -Force",
            "if (-not (Test-Path (Join-Path $msysRoot 'usr\\bin\\bash.exe'))) { throw 'MSYS2 extraction failed.' }",
        ].join('; ');

        await this.runPowerShell(script, 'Install MSYS2');
    }

    private async installPackages(context: ToolchainContext): Promise<void> {
        if (!fs.existsSync(context.bashPath)) {
            throw new Error(`MSYS2 bash not found at ${context.bashPath}`);
        }

        const command = 'pacman -Sy --noconfirm && pacman -S --needed --noconfirm mingw-w64-x86_64-toolchain base-devel mingw-w64-x86_64-cmake mingw-w64-x86_64-SDL2 ninja';
        await this.spawnWithLogs(context.bashPath, ['--login', '-c', command], 'Packages', context.env);
    }

    private async ensureWhisperSource(sourceDir: string, force: boolean): Promise<void> {
        if (!force && fs.existsSync(path.join(sourceDir, 'CMakeLists.txt'))) {
            this.emitConsole('[source] whisper.cpp source is already available.');
            return;
        }

        await fsp.rm(sourceDir, { recursive: true, force: true });

        const script = [
            `$dest = '${sourceDir.replace(/\\/g, '/')}'`,
            "$destParent = Split-Path -Path $dest -Parent",
            "$zip = Join-Path $env:TEMP 'whisper.cpp.zip'",
            "$temp = Join-Path $env:TEMP 'whisper-src'",
            "if (Test-Path $zip) { Remove-Item $zip -Force }",
            "if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }",
            "$url = 'https://github.com/ggerganov/whisper.cpp/archive/refs/heads/master.zip'",
            "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing",
            "Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force",
            "$extracted = Get-ChildItem -Path $temp | Where-Object { $_.PSIsContainer } | Select-Object -First 1",
            "if ($null -eq $extracted) { throw 'whisper.cpp archive missing root folder' }",
            "New-Item -ItemType Directory -Path $destParent -Force | Out-Null",
            "Move-Item -Path $extracted.FullName -Destination $dest",
            "Remove-Item $zip -Force",
            "Remove-Item $temp -Recurse -Force",
        ].join('; ');

        await this.runPowerShell(script, 'Fetch whisper.cpp');
    }

    private async configureWithCmake(context: ToolchainContext, sourceDir: string): Promise<void> {
        const buildDir = path.join(sourceDir, 'build');
        await fsp.rm(buildDir, { recursive: true, force: true });
        await fsp.mkdir(buildDir, { recursive: true });

        const enableVulkan = Boolean(context.vulkanSdkPath);

        const args = [
            '-S', sourceDir,
            '-B', buildDir,
            '-G', 'Ninja',
            enableVulkan ? '-DGGML_VULKAN=1' : '-DGGML_VULKAN=0',
            '-DWHISPER_SDL2=ON',
            '-DWHISPER_BUILD_EXAMPLES=ON',
            `-DSDL2_DIR=${this.toPosixPath(context.sdl2CMakeDir)}`,
            '-DCMAKE_BUILD_TYPE=Release',
            `-DCMAKE_C_COMPILER=${this.toPosixPath(context.gccPath)}`,
            `-DCMAKE_CXX_COMPILER=${this.toPosixPath(context.gxxPath)}`,
            `-DCMAKE_AR=${this.toPosixPath(context.arPath)}`,
            `-DCMAKE_RANLIB=${this.toPosixPath(context.ranlibPath)}`,
            '-DCMAKE_C_ARCHIVE_CREATE=<CMAKE_AR> crs <TARGET> <LINK_FLAGS> <OBJECTS>',
            '-DCMAKE_CXX_ARCHIVE_CREATE=<CMAKE_AR> crs <TARGET> <LINK_FLAGS> <OBJECTS>',
            '-DCMAKE_C_ARCHIVE_FINISH=<CMAKE_RANLIB> <TARGET>',
            '-DCMAKE_CXX_ARCHIVE_FINISH=<CMAKE_RANLIB> <TARGET>',
            '-DGGML_CCACHE=OFF',
        ];

        if (!fs.existsSync(context.cmakePath)) {
            throw new Error(`CMake not found at ${context.cmakePath}`);
        }

        if (!fs.existsSync(context.sdl2CMakeDir)) {
            throw new Error(`SDL2 CMake directory not found at ${context.sdl2CMakeDir}`);
        }

        if (!enableVulkan) {
            this.emitConsole('[compile] Vulkan SDK not found; build will proceed without Vulkan backend.');
        }

        await this.spawnWithLogs(context.cmakePath, args, 'CMake Configure', context.env);
    }

    private async buildBinaries(context: ToolchainContext, sourceDir: string): Promise<void> {
        const buildDir = path.join(sourceDir, 'build');
        const args = [
            '--build', buildDir,
            '--target', 'whisper-cli',
            '--config', 'Release',
            '-j', String(Math.max(1, os.cpus().length - 1)),
        ];

        await this.spawnWithLogs(context.cmakePath, args, 'Build', context.env);
    }

    private async copyArtifacts(context: ToolchainContext, sourceDir: string, binDir: string): Promise<void> {
        const buildBinDir = path.join(sourceDir, 'build', 'bin');

        // Copy whisper-cli.exe
        const cliSrc = path.join(buildBinDir, 'whisper-cli.exe');
        if (!fs.existsSync(cliSrc)) {
            throw new Error(`whisper-cli.exe not found at ${cliSrc}`);
        }
        await fsp.copyFile(cliSrc, path.join(binDir, 'whisper-cli.exe'));

        // Copy required DLLs from MinGW
        for (const dll of REQUIRED_DLLS) {
            const sourcePath = path.join(context.mingwBin, dll);
            if (fs.existsSync(sourcePath)) {
                await fsp.copyFile(sourcePath, path.join(binDir, dll));
            } else {
                this.emitConsole(`[copy] Warning: DLL not found: ${dll}`);
            }
        }

        // Step 8: Copy DLLs
        const buildDir = path.join(sourceDir, 'build');
        const scanDllRecursive = async (dir: string) => {
            if (!fs.existsSync(dir)) return;
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scanDllRecursive(fullPath);
                } else if (entry.name.endsWith('.dll')) {
                    this.emitConsole(`[copy] Found: ${entry.name}`);
                    await fsp.copyFile(fullPath, path.join(binDir, entry.name));
                }
            }
        };
        await scanDllRecursive(buildDir);
    }

    private async runPowerShell(script: string, label: string): Promise<void> {
        const args = [
            '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-Command', script,
        ];
        await this.spawnWithLogs('powershell.exe', args, label);
    }

    private async spawnWithLogs(
        command: string,
        args: string[],
        label?: string,
        env?: NodeJS.ProcessEnv,
    ): Promise<void> {
        const commandLine = `${command} ${args.join(' ')}`.trim();
        this.writeLog(`$ ${commandLine}\n`);

        await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: env ?? process.env,
            });

            let stdoutBuffer = '';
            let stderrBuffer = '';

            const flushBuffer = (buffer: string): string => {
                const lines = buffer.split(/\r?\n/);
                const trailing = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const prefix = label ?? command;
                    this.emitConsole(`[${prefix}] ${trimmed}`);
                }
                return trailing;
            };

            if (child.stdout) {
                child.stdout.on('data', (data) => {
                    this.writeLog(data);
                    stdoutBuffer += data.toString();
                    stdoutBuffer = flushBuffer(stdoutBuffer);
                });
            }

            if (child.stderr) {
                child.stderr.on('data', (data) => {
                    this.writeLog(data);
                    stderrBuffer += data.toString();
                    stderrBuffer = flushBuffer(stderrBuffer);
                });
            }

            child.once('error', (error) => {
                reject(error);
            });

            child.once('close', (code) => {
                if (stdoutBuffer.trim()) {
                    const prefix = label ?? command;
                    this.emitConsole(`[${prefix}] ${stdoutBuffer.trim()}`);
                }
                if (stderrBuffer.trim()) {
                    const prefix = label ?? command;
                    this.emitConsole(`[${prefix}] ${stderrBuffer.trim()}`);
                }

                if (code === 0) {
                    this.writeLog('\n');
                    resolve();
                } else {
                    const prefix = label ?? command;
                    this.writeLog(`\n${command} exited with code ${code}\n`);
                    reject(new Error(`${prefix}: exited with code ${code}`));
                }
            });
        });
    }
}

// Singleton instance
let compileServiceInstance: WhisperCompileService | null = null;

export const getWhisperCompileService = (): WhisperCompileService => {
    if (!compileServiceInstance) {
        compileServiceInstance = new WhisperCompileService();
    }
    return compileServiceInstance;
};
