// Computer control module - extracted from computer-use-mcp
// Provides screenshot, mouse, and keyboard control capabilities
// Converted from TypeScript to JavaScript

import {
  mouse,
  keyboard,
  Point,
  screen,
  Button,
  imageResource,
} from '@nut-tree-fork/nut-js';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Jimp from 'jimp';
import sharp from 'sharp';
import { toKeys } from './keyMapping.js';

// Configure nut-js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 10;

// API limits for image size
const maxLongEdge = 1568;
const maxPixels = 1.15 * 1024 * 1024; // 1.15 megapixels

// Cache for xdotool availability check
let xdotoolAvailable;

/**
 * Check if xdotool is available on this system (Linux only).
 */
function hasXdotool() {
  if (xdotoolAvailable === undefined) {
    try {
      execFileSync('which', ['xdotool'], { stdio: 'ignore' });
      xdotoolAvailable = true;
    } catch {
      xdotoolAvailable = false;
    }
  }
  return xdotoolAvailable;
}

/**
 * Type text using xdotool on Linux (respects X11 keyboard layout).
 */
function xdotoolType(text) {
  execFileSync(
    'xdotool',
    [
      'type',
      '--clearmodifiers',
      '--delay',
      String(keyboard.config.autoDelayMs),
      '--',
      text,
    ],
    {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
    }
  );
}

/**
 * Grab the screen, with macOS fallback for screencapture CLI.
 */
async function grabScreen() {
  try {
    // Try nut-js screen grab first
    const img = await screen.grab();
    return await imageResource.getImage(img);
  } catch {
    // Fallback for macOS (when CGDisplayCreateImageForRect is unavailable)
    const tmpPath = join(tmpdir(), `computer-use-mcp-${Date.now()}.png`);
    try {
      execFileSync('screencapture', ['-x', tmpPath]);
      const buffer = readFileSync(tmpPath);
      return await Jimp.read(buffer);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Calculate scale factor to fit image within API limits.
 */
function getSizeToApiScale(width, height) {
  const longEdge = Math.max(width, height);
  const totalPixels = width * height;

  const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const pixelScale =
    totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

  return Math.min(longEdgeScale, pixelScale);
}

/**
 * Get scale factor from API coordinates to logical screen coordinates.
 */
async function getApiToLogicalScale() {
  const logicalWidth = await screen.width();
  const logicalHeight = await screen.height();
  const apiScaleFactor = getSizeToApiScale(logicalWidth, logicalHeight);
  return 1 / apiScaleFactor;
}

/**
 * Execute a computer action (screenshot, mouse, keyboard, etc).
 * @param {string} action - The action type
 * @param {[number, number]} coordinate - Optional coordinate (x, y)
 * @param {string} text - Optional text for type/key actions
 * @returns {Promise<object>} Result object
 */
export async function executeAction(action, coordinate, text) {
  // Scale coordinates from API image space to logical screen space
  let scaledCoordinate = coordinate;
  if (coordinate) {
    const scale = await getApiToLogicalScale();
    scaledCoordinate = [
      Math.round(coordinate[0] * scale),
      Math.round(coordinate[1] * scale),
    ];

    // Validate coordinates
    const [x, y] = scaledCoordinate;
    const [width, height] = [await screen.width(), await screen.height()];
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(
        `Coordinates (${x}, ${y}) are outside display bounds of ${width}x${height}`
      );
    }
  }

  switch (action) {
    case 'key': {
      if (!text) throw new Error('Text required for key');
      const keys = toKeys(text);
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...keys);
      return { ok: true };
    }

    case 'type': {
      if (!text) throw new Error('Text required for type');
      if (process.platform === 'linux' && hasXdotool()) {
        xdotoolType(text);
      } else {
        await keyboard.type(text);
      }
      return { ok: true };
    }

    case 'get_cursor_position': {
      const pos = await mouse.getPosition();
      const scale = await getApiToLogicalScale();
      return {
        x: Math.round(pos.x / scale),
        y: Math.round(pos.y / scale),
      };
    }

    case 'mouse_move': {
      if (!scaledCoordinate) throw new Error('Coordinate required for mouse_move');
      await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      return { ok: true };
    }

    case 'left_click': {
      if (scaledCoordinate) {
        await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      }
      await mouse.leftClick();
      return { ok: true };
    }

    case 'left_click_drag': {
      if (!scaledCoordinate) throw new Error('Coordinate required for left_click_drag');
      await mouse.pressButton(Button.LEFT);
      await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      await mouse.releaseButton(Button.LEFT);
      return { ok: true };
    }

    case 'right_click': {
      if (scaledCoordinate) {
        await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      }
      await mouse.rightClick();
      return { ok: true };
    }

    case 'middle_click': {
      if (scaledCoordinate) {
        await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      }
      await mouse.click(Button.MIDDLE);
      return { ok: true };
    }

    case 'double_click': {
      if (scaledCoordinate) {
        await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
      }
      await mouse.doubleClick(Button.LEFT);
      return { ok: true };
    }

    case 'scroll': {
      if (!scaledCoordinate) throw new Error('Coordinate required for scroll');
      if (!text) throw new Error('Text required for scroll (e.g., "down", "up:500")');

      const parts = text.split(':');
      const direction = parts[0];
      const amount = parts[1] ? parseInt(parts[1], 10) : 300;

      if (!direction) throw new Error('Scroll direction required');
      if (parts[1] && (isNaN(amount) || amount <= 0)) {
        throw new Error(`Invalid scroll amount: ${parts[1]}`);
      }

      await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));

      switch (direction.toLowerCase()) {
        case 'up':
          await mouse.scrollUp(amount);
          break;
        case 'down':
          await mouse.scrollDown(amount);
          break;
        case 'left':
          await mouse.scrollLeft(amount);
          break;
        case 'right':
          await mouse.scrollRight(amount);
          break;
        default:
          throw new Error(
            `Invalid scroll direction: ${direction}. Use "up", "down", "left", or "right"`
          );
      }
      return { ok: true };
    }

    case 'get_screenshot': {
      // Wait for things to load
      await sleep(1000);

      const cursorPos = await mouse.getPosition();
      const image = await grabScreen();

      // Resize to fit API limits
      const apiScaleFactor = getSizeToApiScale(image.getWidth(), image.getHeight());
      if (apiScaleFactor < 1) {
        image.resize(
          Math.floor(image.getWidth() * apiScaleFactor),
          Math.floor(image.getHeight() * apiScaleFactor)
        );
      }

      // Convert cursor position to image coordinates
      const scale = await getApiToLogicalScale();
      const cursorInImageX = Math.floor(cursorPos.x / scale);
      const cursorInImageY = Math.floor(cursorPos.y / scale);

      // Draw red crosshair at cursor position
      const crosshairSize = 20;
      const crosshairColor = 0xff0000ff; // Red RGBA
      const imageWidth = image.getWidth();
      const imageHeight = image.getHeight();

      // Horizontal line
      for (
        let x = Math.max(0, cursorInImageX - crosshairSize);
        x <= Math.min(imageWidth - 1, cursorInImageX + crosshairSize);
        x++
      ) {
        if (cursorInImageY >= 0 && cursorInImageY < imageHeight) {
          image.setPixelColor(crosshairColor, x, cursorInImageY);
          if (cursorInImageY > 0) {
            image.setPixelColor(crosshairColor, x, cursorInImageY - 1);
          }
          if (cursorInImageY < imageHeight - 1) {
            image.setPixelColor(crosshairColor, x, cursorInImageY + 1);
          }
        }
      }

      // Vertical line
      for (
        let y = Math.max(0, cursorInImageY - crosshairSize);
        y <= Math.min(imageHeight - 1, cursorInImageY + crosshairSize);
        y++
      ) {
        if (cursorInImageX >= 0 && cursorInImageX < imageWidth) {
          image.setPixelColor(crosshairColor, cursorInImageX, y);
          if (cursorInImageX > 0) {
            image.setPixelColor(crosshairColor, cursorInImageX - 1, y);
          }
          if (cursorInImageX < imageWidth - 1) {
            image.setPixelColor(crosshairColor, cursorInImageX + 1, y);
          }
        }
      }

      // Get PNG buffer and compress
      const pngBuffer = await image.getBufferAsync('image/png');
      const optimizedBuffer = await sharp(pngBuffer)
        .png({ quality: 80, compressionLevel: 9 })
        .toBuffer();

      const base64Data = optimizedBuffer.toString('base64');

      return {
        image_width: imageWidth,
        image_height: imageHeight,
        image: base64Data,
        mimeType: 'image/png',
      };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Get system status information.
 */
export async function getSystemStatus() {
  return {
    ok: true,
    platform: process.platform,
    screenWidth: await screen.width(),
    screenHeight: await screen.height(),
    hasXdotool: process.platform === 'linux' ? hasXdotool() : false,
  };
}
