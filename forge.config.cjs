const shouldSignMac = !!process.env.APPLE_TEAM_ID;
const shouldSignWindows = !!process.env.WINDOWS_CERTIFICATE_FILE;

const ffmpegBinary = `ffmpeg-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;

module.exports = {
  packagerConfig: {
    name: 'AgentWFY',
    appBundleId: 'app.agentwfy',
    icon: './icons/icon',
    asar: true,
    extraResource: [`./resources/bin/${ffmpegBinary}`],
    ignore: (file) => {
      // Include the root directory
      if (file === '') return false;
      // Include package.json (app manifest)
      if (file === '/package.json') return false;
      // Include compiled output
      if (file.startsWith('/dist')) return false;
      // Include production dependencies
      if (file.startsWith('/node_modules')) return false;
      // Ignore everything else (src, scripts, configs, etc.)
      return true;
    },
    ...(shouldSignMac && {
      osxSign: {
        identity: process.env.APPLE_IDENTITY || 'Developer ID Application',
      },
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    }),
  },

  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'AgentWFY',
        icon: './icons/icon.icns',
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'AgentWFY',
        setupIcon: './icons/icon.ico',
        ...(shouldSignWindows && {
          certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
          certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
        }),
      },
    },
  ],

  hooks: {
    generateAssets: async () => {
      const { execSync } = require('child_process');
      execSync('npm run build', { stdio: 'inherit' });
      const platform = `${process.platform}-${process.arch}`;
      execSync(`node scripts/download-ffmpeg.mjs ${platform}`, { stdio: 'inherit' });
    },
  },
};
