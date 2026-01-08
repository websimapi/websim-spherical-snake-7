import { jsxDEV } from "react/jsx-dev-runtime";
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@websim/remotion/player";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, Audio, Sequence } from "remotion";
import * as THREE from "three";
const ReplayScene = ({ data, isMuted }) => {
  const frameIndex = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const containerRef = useRef(null);
  const [avatarSrc, setAvatarSrc] = useState(null);
  const { audioCues, rippleEvents } = useMemo(() => {
    const cues = [];
    const ripples = [];
    if (!data || !data.frames) return { audioCues: cues, rippleEvents: ripples };
    data.frames.forEach((frame, idx) => {
      if (frame.events && frame.events.length > 0) {
        frame.events.forEach((evt, i) => {
          const name = typeof evt === "string" ? evt : evt.name;
          const payload = typeof evt === "string" ? null : evt.payload;
          const url = data.config.sounds && data.config.sounds[name];
          if (url) {
            cues.push({
              id: `sfx-${idx}-${i}-${name}`,
              frame: idx,
              src: url,
              name
            });
          }
          if (name === "ripple" && payload) {
            ripples.push({
              frame: idx,
              center: new THREE.Vector3().fromArray(payload.center),
              duration: payload.duration
            });
          }
        });
      }
    });
    return { audioCues: cues, rippleEvents: ripples };
  }, [data]);
  const activeCues = audioCues.filter((cue) => {
    const duration = cue.name === "die" ? 150 : 30;
    return frameIndex >= cue.frame && frameIndex < cue.frame + duration;
  });
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const rippleUniforms = useRef({
    uTime: { value: 0 },
    uRippleCenters: { value: new Array(5).fill().map(() => new THREE.Vector3()) },
    uRippleStartTimes: { value: new Array(5).fill(-1e3) },
    uRippleIntensities: { value: new Array(5).fill(0) }
  });
  const objectsRef = useRef({
    earth: null,
    head: null,
    tongue: null,
    food: null,
    bonusFoods: [],
    segments: [],
    cameraRig: null
  });
  useEffect(() => {
    if (!data || !data.frames || data.frames.length === 0) return;
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1e3);
    cameraRef.current = camera;
    const cameraRig = new THREE.Group();
    scene.add(cameraRig);
    cameraRig.add(camera);
    camera.position.z = 25;
    camera.position.y = 10;
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setClearColor(0, 1);
    if (containerRef.current) {
      containerRef.current.appendChild(renderer.domElement);
    }
    rendererRef.current = renderer;
    const ambientLight = new THREE.AmbientLight(16777215, 0.5);
    scene.add(ambientLight);
    const hemiLight = new THREE.HemisphereLight(16777215, 4473924, 1);
    scene.add(hemiLight);
    const r = data.config.earthRadius;
    const earthGeo = new THREE.SphereGeometry(r, 64, 64);
    const earthMat = new THREE.MeshStandardMaterial({
      color: 8965375,
      emissive: 8772,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.7,
      roughness: 0.9,
      side: THREE.DoubleSide
    });
    earthMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = rippleUniforms.current.uTime;
      shader.uniforms.uRippleCenters = rippleUniforms.current.uRippleCenters;
      shader.uniforms.uRippleStartTimes = rippleUniforms.current.uRippleStartTimes;
      shader.uniforms.uRippleIntensities = rippleUniforms.current.uRippleIntensities;
      shader.vertexShader = `varying vec3 vWorldPos;
` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
                vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
      const rippleFunc = `
                uniform float uTime;
                uniform vec3 uRippleCenters[5];
                uniform float uRippleStartTimes[5];
                uniform float uRippleIntensities[5];
                varying vec3 vWorldPos;

                float getRipple(int i, vec3 pos) {
                    float startTime = uRippleStartTimes[i];
                    if (startTime < 0.0) return 0.0;
                    
                    float age = uTime - startTime;
                    if (age < 0.0 || age > 2.0) return 0.0; // Lifetime 2s
                    
                    vec3 center = uRippleCenters[i];
                    float intensity = uRippleIntensities[i];
                    
                    float dotProd = dot(normalize(pos), normalize(center));
                    float angle = acos(clamp(dotProd, -1.0, 1.0));
                    float dist = angle * 10.0; // approx distance on sphere radius 10
                    
                    float speed = 8.0; 
                    float waveCenter = age * speed;
                    float distDiff = dist - waveCenter;
                    
                    float ripple = 0.0;
                    if (abs(distDiff) < 2.0) {
                        ripple = sin(distDiff * 3.0) * exp(-distDiff * distDiff);
                    }
                    ripple *= (1.0 - age / 2.0);
                    ripple *= intensity;
                    return ripple;
                }
            `;
      shader.fragmentShader = rippleFunc + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
                float totalRipple = 0.0;
                for(int i=0; i<5; i++) {
                    totalRipple += getRipple(i, vWorldPos);
                }
                if (abs(totalRipple) > 0.01) {
                    float strength = smoothstep(0.0, 0.5, abs(totalRipple));
                    vec3 rippleColor = vec3(0.7, 0.9, 1.0);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, rippleColor, strength * 0.4);
                    gl_FragColor.rgb += rippleColor * strength * 0.2;
                }`
      );
    };
    const earth = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earth);
    const atmGeo = new THREE.SphereGeometry(r * 1.03, 64, 64);
    const atmMat = new THREE.MeshBasicMaterial({
      color: 4491519,
      transparent: true,
      opacity: 0.1,
      side: THREE.BackSide
    });
    scene.add(new THREE.Mesh(atmGeo, atmMat));
    const headGeo = new THREE.BoxGeometry(0.8, 0.4, 0.8);
    const headMat = new THREE.MeshStandardMaterial({ color: 65280, emissive: 17408 });
    const head = new THREE.Mesh(headGeo, headMat);
    const eyeGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const eyeWhiteMat = new THREE.MeshStandardMaterial({
      color: 16777215,
      emissive: 2236962,
      emissiveIntensity: 0.2,
      roughness: 0.2,
      metalness: 0
    });
    const pupilGeo = new THREE.SphereGeometry(0.06, 12, 12);
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0, roughness: 0 });
    const highlightGeo = new THREE.SphereGeometry(0.025, 8, 8);
    const highlightMat = new THREE.MeshBasicMaterial({ color: 16777215 });
    const createEye = (x) => {
      const eye = new THREE.Mesh(eyeGeo, eyeWhiteMat);
      eye.position.set(x, 0.15, 0.25);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(Math.sign(x) * 0.05, 0.02, 0.09);
      eye.add(pupil);
      const hl = new THREE.Mesh(highlightGeo, highlightMat);
      hl.position.set(Math.sign(x) * 0.02, 0.03, 0.05);
      pupil.add(hl);
      return eye;
    };
    head.add(createEye(0.22));
    head.add(createEye(-0.22));
    const tongueGeo = new THREE.BoxGeometry(0.08, 0.02, 0.6);
    const tongueMat = new THREE.MeshStandardMaterial({ color: 16724838, emissive: 6684689, emissiveIntensity: 0.5 });
    const tongue = new THREE.Mesh(tongueGeo, tongueMat);
    tongue.position.set(0, -0.1, 0.4);
    tongue.scale.set(1, 1, 0.01);
    head.add(tongue);
    scene.add(head);
    const foodGeo = new THREE.SphereGeometry(0.5, 16, 16);
    const foodMat = new THREE.MeshStandardMaterial({ color: 16755200, emissive: 16711680, emissiveIntensity: 0.5 });
    const food = new THREE.Mesh(foodGeo, foodMat);
    scene.add(food);
    objectsRef.current = {
      earth,
      head,
      tongue,
      food,
      bonusFoods: [],
      segments: [],
      cameraRig
    };
    return () => {
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
      sceneRef.current = null;
    };
  }, [width, height, data]);
  useLayoutEffect(() => {
    if (!sceneRef.current || !rendererRef.current || !data.frames) return;
    const safeIndex = Math.min(Math.floor(frameIndex), data.frames.length - 1);
    if (safeIndex < 0) return;
    const frameData = data.frames[safeIndex];
    const objs = objectsRef.current;
    const currentTime = safeIndex / fps;
    rippleUniforms.current.uTime.value = currentTime;
    let activeRippleCount = 0;
    for (let i = 0; i < 5; i++) rippleUniforms.current.uRippleStartTimes.value[i] = -1e3;
    for (const rip of rippleEvents) {
      const ripTime = rip.frame / fps;
      const age = currentTime - ripTime;
      if (age >= 0 && age < 2 && activeRippleCount < 5) {
        rippleUniforms.current.uRippleCenters.value[activeRippleCount].copy(rip.center);
        rippleUniforms.current.uRippleStartTimes.value[activeRippleCount] = ripTime;
        let intensity = 0.15;
        if (rip.duration > 200) {
          const factor = Math.min((rip.duration - 200) / 400, 1);
          intensity = 0.15 + factor * 0.3;
        }
        rippleUniforms.current.uRippleIntensities.value[activeRippleCount] = intensity;
        activeRippleCount++;
      }
    }
    if (!objs.head || !objs.food) return;
    objs.head.position.fromArray(frameData.head.pos);
    objs.head.quaternion.fromArray(frameData.head.quat);
    if (objs.tongue && frameData.tongue) {
      objs.tongue.scale.set(frameData.tongue.scaleX, 1, frameData.tongue.scaleZ);
    }
    objs.food.position.fromArray(frameData.food);
    const bonusData = frameData.bonusFoods || [];
    while (objs.bonusFoods.length < bonusData.length) {
      const bGeo = new THREE.SphereGeometry(0.25, 8, 8);
      const bMat = new THREE.MeshStandardMaterial({
        color: 16776960,
        emissive: 16755200,
        emissiveIntensity: 0.5
      });
      const mesh = new THREE.Mesh(bGeo, bMat);
      sceneRef.current.add(mesh);
      objs.bonusFoods.push(mesh);
    }
    while (objs.bonusFoods.length > bonusData.length) {
      const mesh = objs.bonusFoods.pop();
      if (mesh) {
        sceneRef.current.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
      }
    }
    bonusData.forEach((pos, i) => {
      if (objs.bonusFoods[i]) {
        objs.bonusFoods[i].position.fromArray(pos);
      }
    });
    while (objs.segments.length < frameData.segments.length) {
      const segGeo = new THREE.BoxGeometry(0.6, 0.3, 0.6);
      const colorHex = frameData.segments[objs.segments.length].color;
      const segMat = new THREE.MeshStandardMaterial({ color: colorHex });
      const segment = new THREE.Mesh(segGeo, segMat);
      sceneRef.current.add(segment);
      objs.segments.push(segment);
    }
    while (objs.segments.length > frameData.segments.length) {
      const segment = objs.segments.pop();
      if (segment && sceneRef.current) {
        sceneRef.current.remove(segment);
        if (segment.geometry) segment.geometry.dispose();
        if (segment.material) segment.material.dispose();
      }
    }
    frameData.segments.forEach((segData, i) => {
      if (objs.segments[i]) {
        objs.segments[i].position.fromArray(segData.pos);
        objs.segments[i].quaternion.fromArray(segData.quat);
        if (segData.color !== void 0) {
          objs.segments[i].material.color.setHex(segData.color);
        }
      }
    });
    if (frameData.camera && cameraRef.current) {
      cameraRef.current.position.fromArray(frameData.camera.pos);
      cameraRef.current.quaternion.fromArray(frameData.camera.quat);
      cameraRef.current.up.fromArray(frameData.camera.up);
    }
    if (rendererRef.current && sceneRef.current && cameraRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }, [frameIndex, data, fps]);
  const currentFrameData = data.frames[Math.min(Math.floor(frameIndex), data.frames.length - 1)] || {};
  const score = currentFrameData.score || 0;
  const playerInfo = data.config.playerInfo || { username: "Player", avatarUrl: "./default_avatar.png" };
  return /* @__PURE__ */ jsxDEV(AbsoluteFill, { children: [
    /* @__PURE__ */ jsxDEV("div", { ref: containerRef, style: { width: "100%", height: "100%" } }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 406,
      columnNumber: 13
    }),
    /* @__PURE__ */ jsxDEV("div", { style: {
      position: "absolute",
      top: "20px",
      left: "20px",
      display: "flex",
      alignItems: "flex-start",
      gap: "15px",
      pointerEvents: "none",
      fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
    }, children: [
      /* @__PURE__ */ jsxDEV("div", { style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "5px"
      }, children: [
        /* @__PURE__ */ jsxDEV(
          "img",
          {
            src: playerInfo.avatarUrl || "./default_avatar.png",
            onError: (e) => {
              e.target.onerror = null;
              e.target.src = "./default_avatar.png";
            },
            style: {
              width: "64px",
              height: "64px",
              borderRadius: "50%",
              border: "3px solid white",
              backgroundColor: "#333",
              objectFit: "cover",
              boxShadow: "0 4px 6px rgba(0,0,0,0.3)"
            }
          },
          void 0,
          false,
          {
            fileName: "<stdin>",
            lineNumber: 425,
            columnNumber: 21
          }
        ),
        /* @__PURE__ */ jsxDEV("div", { style: {
          color: "white",
          fontSize: "14px",
          fontWeight: "600",
          textShadow: "1px 1px 2px rgba(0,0,0,0.8)",
          background: "rgba(0,0,0,0.5)",
          padding: "2px 6px",
          borderRadius: "4px",
          maxWidth: "100px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }, children: playerInfo.username }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 441,
          columnNumber: 21
        })
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 419,
        columnNumber: 17
      }),
      /* @__PURE__ */ jsxDEV("div", { style: {
        fontSize: "48px",
        color: "white",
        fontWeight: "bold",
        textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
        alignSelf: "flex-start",
        marginTop: "10px"
      }, children: score }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 457,
        columnNumber: 17
      })
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 409,
      columnNumber: 13
    }),
    activeCues.map((cue) => {
      const duration = cue.name === "die" ? 150 : 30;
      return /* @__PURE__ */ jsxDEV(Sequence, { from: cue.frame, durationInFrames: duration, children: /* @__PURE__ */ jsxDEV(Audio, { src: cue.src, volume: isMuted ? 0 : 1 }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 473,
        columnNumber: 25
      }) }, cue.id, false, {
        fileName: "<stdin>",
        lineNumber: 472,
        columnNumber: 21
      });
    })
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 405,
    columnNumber: 9
  });
};
const ReplayContainer = ({ data }) => {
  const [isMuted, setIsMuted] = useState(() => data.config?.muted || false);
  const duration = data.frames.length;
  const fps = data.config.fps || 30;
  return /* @__PURE__ */ jsxDEV("div", { style: { width: "100%", height: "100%", position: "relative", background: "#000" }, children: [
    /* @__PURE__ */ jsxDEV(
      Player,
      {
        component: ReplayScene,
        inputProps: { data, isMuted },
        durationInFrames: duration,
        fps,
        compositionWidth: window.innerWidth,
        compositionHeight: window.innerHeight,
        style: { width: "100%", height: "100%" },
        controls: true,
        loop: true,
        autoPlay: true,
        numberOfSharedAudioTags: 20,
        showRenderButton: false
      },
      void 0,
      false,
      {
        fileName: "<stdin>",
        lineNumber: 490,
        columnNumber: 13
      }
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        onClick: () => setIsMuted(!isMuted),
        style: {
          position: "absolute",
          right: "16px",
          bottom: "16px",
          zIndex: 100,
          width: "44px",
          height: "44px",
          borderRadius: "50%",
          border: "none",
          background: "rgba(0, 0, 0, 0.6)",
          color: "#fff",
          fontSize: "22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          pointerEvents: "auto"
        },
        children: isMuted ? "\u{1F507}" : "\u{1F50A}"
      },
      void 0,
      false,
      {
        fileName: "<stdin>",
        lineNumber: 504,
        columnNumber: 13
      }
    )
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 489,
    columnNumber: 9
  });
};
let replayRoot = null;
const mountReplay = (containerId, replayData) => {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (replayRoot) {
    replayRoot.unmount();
  }
  replayRoot = createRoot(container);
  replayRoot.render(/* @__PURE__ */ jsxDEV(ReplayContainer, { data: replayData }, void 0, false, {
    fileName: "<stdin>",
    lineNumber: 544,
    columnNumber: 23
  }));
};
const unmountReplay = () => {
  if (replayRoot) {
    replayRoot.unmount();
    replayRoot = null;
  }
};
export {
  mountReplay,
  unmountReplay
};
