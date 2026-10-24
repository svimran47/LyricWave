/**
 * Liquid Glass Engine for LyricWave
 * Inspired by Apple VisionOS / iOS Liquid Glass and adapted from liquid-glass-react.
 * Provides physical edge refraction, chromatic aberration, specular rim lighting,
 * and fluid cursor/orientation elasticity — 100% native Vanilla JavaScript.
 */

import { displacementMap, polarDisplacementMap, prominentDisplacementMap } from './liquid-glass-textures.js';

let filterInjected = false;

/**
 * Injects the SVG chromatic refraction filter into the DOM if not already present.
 * @param {object} [options]
 * @param {'standard'|'polar'|'prominent'} [options.mode='standard']
 * @param {number} [options.displacementScale=24]
 * @param {number} [options.aberrationIntensity=2]
 */
export function initLiquidGlassFilter(options = {}) {
  if (typeof document === 'undefined') return;
  if (document.getElementById('lw-glass-filter-svg')) return;

  const mode = options.mode || 'standard';
  const scale = Number.isFinite(options.displacementScale) ? options.displacementScale : 24;
  const aberration = Number.isFinite(options.aberrationIntensity) ? options.aberrationIntensity : 2;

  let mapUrl = displacementMap;
  if (mode === 'polar') mapUrl = polarDisplacementMap;
  else if (mode === 'prominent') mapUrl = prominentDisplacementMap;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'lw-glass-filter-svg';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'fixed';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.pointerEvents = 'none';
  svg.style.opacity = '0';
  svg.style.zIndex = '-9999';

  // Scale offsets for RGB chromatic dispersion
  const scaleR = -scale;
  const scaleG = -(scale - aberration * 1.5);
  const scaleB = -(scale - aberration * 3.0);

  svg.innerHTML = `
    <defs>
      <filter id="lw-glass-filter" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
        <feImage id="lwFeImage" x="0" y="0" width="100%" height="100%" result="DISP_MAP" href="${mapUrl}" preserveAspectRatio="none" />
        
        <!-- Edge mask extracted from displacement texture -->
        <feColorMatrix in="DISP_MAP" type="matrix"
          values="0.33 0.33 0.33 0 0
                  0.33 0.33 0.33 0 0
                  0.33 0.33 0.33 0 0
                  0    0    0    1 0" result="EDGE_INTENSITY" />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="discrete" tableValues="0 ${Math.min(1, aberration * 0.06)} 1" />
        </feComponentTransfer>

        <!-- Clean undisplaced source for the center reading area -->
        <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />

        <!-- Red channel displacement -->
        <feDisplacementMap in="SourceGraphic" in2="DISP_MAP" scale="${scaleR}" xChannelSelector="R" yChannelSelector="B" result="RED_DISP" />
        <feColorMatrix in="RED_DISP" type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0" result="RED_CH" />

        <!-- Green channel displacement -->
        <feDisplacementMap in="SourceGraphic" in2="DISP_MAP" scale="${scaleG}" xChannelSelector="R" yChannelSelector="B" result="GREEN_DISP" />
        <feColorMatrix in="GREEN_DISP" type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0" result="GREEN_CH" />

        <!-- Blue channel displacement -->
        <feDisplacementMap in="SourceGraphic" in2="DISP_MAP" scale="${scaleB}" xChannelSelector="R" yChannelSelector="B" result="BLUE_DISP" />
        <feColorMatrix in="BLUE_DISP" type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0" result="BLUE_CH" />

        <!-- Recompose RGB via screen blending -->
        <feBlend in="GREEN_CH" in2="BLUE_CH" mode="screen" result="GB_CH" />
        <feBlend in="RED_CH" in2="GB_CH" mode="screen" result="RGB_ABERRATED" />

        <!-- Mask aberration to outer rim only -->
        <feComposite in="RGB_ABERRATED" in2="EDGE_MASK" operator="in" result="EDGE_WARPED" />

        <!-- Keep center text crystal-clear -->
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />

        <!-- Composite edge refraction over clean center -->
        <feComposite in="EDGE_WARPED" in2="CENTER_CLEAN" operator="over" />
      </filter>
    </defs>
  `;

  document.body.appendChild(svg);
  filterInjected = true;
}

/**
 * Binds pointer tracking, tilt reactivity, and elasticity to an element.
 * @param {HTMLElement} element
 * @param {object} [options]
 * @param {number} [options.elasticity=0.12] 0 = rigid, >0 = fluid elasticity
 * @param {HTMLElement|Window} [options.container=window]
 * @returns {() => void} cleanup function
 */
export function attachLiquidGlass(element, options = {}) {
  if (!element || typeof window === 'undefined') return () => {};

  initLiquidGlassFilter();

  const elasticity = Number.isFinite(options.elasticity) ? options.elasticity : 0.12;
  const container = options.container || window;
  let rafId = 0;
  let targetX = 0;
  let targetY = 0;
  let isPointerActive = false;

  const isReducedMotion = () => {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };

  function update() {
    rafId = 0;
    if (!element.isConnected) return;

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const deltaX = targetX - centerX;
    const deltaY = targetY - centerY;
    const offsetX = rect.width > 0 ? (deltaX / rect.width) * 100 : 0;
    const offsetY = rect.height > 0 ? (deltaY / rect.height) * 100 : 0;

    // Steer the specular light reflection angle around the capsule rim
    const angle = 135 + offsetX * 1.2;
    const glareIntensity = Math.min(0.65, 0.28 + Math.abs(offsetX) * 0.007);

    element.style.setProperty('--glass-glare-angle', `${angle.toFixed(1)}deg`);
    element.style.setProperty('--glass-glare-intensity', glareIntensity.toFixed(3));
    element.style.setProperty('--glass-mouse-x', `${offsetX.toFixed(1)}%`);
    element.style.setProperty('--glass-mouse-y', `${offsetY.toFixed(1)}%`);

    // Optional elasticity (spring translation and micro-stretch)
    if (elasticity > 0 && isPointerActive && !isReducedMotion()) {
      const dist = Math.hypot(deltaX, deltaY);
      const activationRadius = 260;
      if (dist < activationRadius) {
        const factor = (1 - dist / activationRadius) * elasticity;
        const tx = deltaX * factor * 0.12;
        const ty = deltaY * factor * 0.12;
        element.style.setProperty('--glass-elastic-x', `${tx.toFixed(2)}px`);
        element.style.setProperty('--glass-elastic-y', `${ty.toFixed(2)}px`);
      } else {
        element.style.removeProperty('--glass-elastic-x');
        element.style.removeProperty('--glass-elastic-y');
      }
    }
  }

  function onPointerMove(e) {
    targetX = e.clientX;
    targetY = e.clientY;
    isPointerActive = true;
    if (!rafId) rafId = requestAnimationFrame(update);
  }

  function onPointerLeave() {
    isPointerActive = false;
    element.style.removeProperty('--glass-elastic-x');
    element.style.removeProperty('--glass-elastic-y');
  }

  // Device orientation / gyroscope support for mobile devices
  function onOrientation(e) {
    if (isPointerActive) return; // Pointer has precedence
    if (e.gamma == null || e.beta == null) return;
    // Map gamma (-45 to 45 deg tilt) to simulated offsetX
    const tiltX = Math.max(-50, Math.min(50, e.gamma * 1.5));
    const angle = 135 + tiltX * 1.4;
    element.style.setProperty('--glass-glare-angle', `${angle.toFixed(1)}deg`);
  }

  container.addEventListener('pointermove', onPointerMove, { passive: true });
  container.addEventListener('pointerleave', onPointerLeave, { passive: true });
  if (typeof window.DeviceOrientationEvent !== 'undefined') {
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  }

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('deviceorientation', onOrientation);
  };
}
