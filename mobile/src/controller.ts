// Singleton AppController instance. Custom elements can't easily receive
// constructor args, so they import this singleton instead of receiving one
// via a property. Matches the desktop renderer pattern (e.g. desktop's
// stores are module-level singletons too).

import { AppController } from './app-controller.js'

export const controller = new AppController()
