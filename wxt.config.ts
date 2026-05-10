import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      if (manifest.sidebar_action) {
        manifest.sidebar_action.default_icon = {
          16: 'icon/16.png',
          32: 'icon/32.png',
          48: 'icon/48.png',
          128: 'icon/128.png',
        };
      }
    },
  },
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    const firefoxExtensionId = process.env.FIREFOX_EXTENSION_ID || 'tactus@local.dev';

    return {
      name: 'Tactus',
      description: 'The first browser AI Agent extension with Agent Skills, multi-provider AI, and MCP support',
      version: '1.3.3',
      ...(isFirefox ? {} : { minimum_chrome_version: '120' }),
      permissions: [
        'storage',
        'unlimitedStorage',
        'activeTab',
        'scripting',
        'identity',
        ...(isFirefox ? [] : ['sidePanel', 'debugger', 'tabs', 'tabGroups']),
      ],
      host_permissions: ['<all_urls>'],
      action: {
        default_title: 'Tactus',
        default_icon: {
          16: '/icon/16.png',
          32: '/icon/32.png',
          48: '/icon/48.png',
          128: '/icon/128.png',
        },
      },
      ...(isFirefox
        ? {}
        : {
            side_panel: {
              default_path: 'sidepanel.html',
            },
          }),
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      web_accessible_resources: [
        {
          resources: ['/icon/*'],
          matches: ['<all_urls>'],
        },
      ],
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: firefoxExtensionId,
                data_collection_permissions: {
                  required: ['none'],
                },
              },
            },
          }
        : {}),
    };
  },
});
