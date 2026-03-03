import { exec } from "child_process";
import os from "os";

export type HardwareInfo = {
    cpuName: string;
    totalRamGB: number;
    gpus: string[];
    hasNvidiaGpu: boolean;
    hasAmdGpu: boolean;
    hasVulkanGpu: boolean;
};

export const getHardwareInfo = (): Promise<HardwareInfo> => {
    return new Promise((resolve) => {
        const cpuName = os.cpus()[0]?.model || "Unknown CPU";
        const totalRamGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));

        // Detect GPUs on Windows using PowerShell
        if (process.platform === "win32") {
            exec("powershell -command \"Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name\"", (error, stdout) => {
                let gpus: string[] = [];
                let hasNvidiaGpu = false;
                let hasAmdGpu = false;
                let hasVulkanGpu = false;

                if (!error && stdout) {
                    const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                    gpus = lines;
                    hasNvidiaGpu = lines.some(name => name.toLowerCase().includes("nvidia"));
                    hasAmdGpu = lines.some(name =>
                        name.toLowerCase().includes("amd") || name.toLowerCase().includes("radeon")
                    );
                    // Vulkan được hỗ trợ bởi NVIDIA, AMD, và Intel (từ Gen 9+)
                    const hasIntelGpu = lines.some(name =>
                        name.toLowerCase().includes("intel") && (
                            name.toLowerCase().includes("arc") ||
                            name.toLowerCase().includes("iris") ||
                            name.toLowerCase().includes("uhd") ||
                            name.toLowerCase().includes("hd graphics")
                        )
                    );
                    hasVulkanGpu = hasNvidiaGpu || hasAmdGpu || hasIntelGpu;
                }

                resolve({
                    cpuName,
                    totalRamGB,
                    gpus,
                    hasNvidiaGpu,
                    hasAmdGpu,
                    hasVulkanGpu,
                });
            });
        } else {
            resolve({
                cpuName,
                totalRamGB,
                gpus: ["Unknown GPU"],
                hasNvidiaGpu: false,
                hasAmdGpu: false,
                hasVulkanGpu: false,
            });
        }
    });
};
