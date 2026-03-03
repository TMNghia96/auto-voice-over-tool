import { ipcMain } from 'electron';
import { getWhisperCompileService } from '../services/WhisperCompileService';

export const setupCompileIpc = () => {
    ipcMain.on('compile-whisper-vulkan', (event) => {
        const compileService = getWhisperCompileService();

        if (compileService.isRunning()) {
            event.sender.send('compile-progress', {
                step: 'error',
                message: 'Đang biên dịch, vui lòng chờ...',
                progress: 0,
                state: 'error',
            });
            return;
        }

        const progressHandler = (progress: any) => {
            event.sender.send('compile-progress', progress);
        };

        const consoleHandler = (data: any) => {
            event.sender.send('compile-console', data);
        };

        compileService.on('progress', progressHandler);
        compileService.on('console', consoleHandler);

        // Get the output directory from EnvironmentService
        const { app } = require('electron');
        const path = require('path');
        const isDev = !app.isPackaged;
        const BIN_DIR = isDev
            ? path.join(process.cwd(), 'bin')
            : path.join(app.getPath('userData'), 'bin');
        const vulkanDir = path.join(BIN_DIR, 'whisper-vulkan');

        compileService.compile(vulkanDir).then((result) => {
            event.sender.send('compile-complete', result);
            compileService.off('progress', progressHandler);
            compileService.off('console', consoleHandler);
        });
    });

    ipcMain.handle('check-whisper-compile-status', () => {
        const compileService = getWhisperCompileService();
        return { isRunning: compileService.isRunning() };
    });
};
