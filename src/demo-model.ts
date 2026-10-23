import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type DemoPreset = 'helmet' | 'sphere' | 'cube';

/** Split the built-in primitive groups before packing, so caps and cube faces never overlap. */
function splitPrimitiveUVs(geometry: THREE.BufferGeometry) {
  if (geometry.groups.length < 2) return geometry;
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const uv = source.getAttribute('uv');
  const columns = Math.ceil(Math.sqrt(source.groups.length));
  source.groups.forEach((group, index) => {
    const col = index % columns, row = Math.floor(index / columns);
    for (let i = group.start; i < group.start + group.count; i++) {
      uv.setXY(i, (col + .04 + uv.getX(i) * .92) / columns, (row + .04 + uv.getY(i) * .92) / columns);
    }
  });
  source.clearGroups();
  if (source !== geometry) geometry.dispose();
  return source;
}

export function buildDemo(preset: DemoPreset): THREE.Group {
  const group = new THREE.Group();
  group.name = preset === 'helmet' ? 'Explorer helmet' : preset === 'sphere' ? 'Material study' : 'Beveled cube';
  const materials = {
    body: new THREE.MeshStandardMaterial({ name: 'Body', color: '#c9b77c', roughness: .43, metalness: .22 }),
    visor: new THREE.MeshStandardMaterial({ name: 'Visor', color: '#16323d', roughness: .17, metalness: .78 }),
    hardware: new THREE.MeshStandardMaterial({ name: 'Hardware', color: '#343c40', roughness: .49, metalness: .7 }),
  };
  const pieces: Record<string, THREE.Mesh[]> = { body: [], visor: [], hardware: [] };
  function add(name: string, geometry: THREE.BufferGeometry, set: keyof typeof materials,
    position: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1],
    rotation: [number, number, number] = [0, 0, 0]) {
    const mesh = new THREE.Mesh(splitPrimitiveUVs(geometry), materials[set]);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    mesh.userData.setIds = [set];
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    pieces[set].push(mesh);
    return mesh;
  }
  const sphere = (radius: number, width = 64, height = 40, start = 0, length = Math.PI * 2, theta = 0, thetaLength = Math.PI) =>
    new THREE.SphereGeometry(radius, width, height, start, length, theta, thetaLength);
  const box = (w: number, h: number, d: number, radius = .035) => new RoundedBoxGeometry(w, h, d, 2, radius);
  const ring = (radius: number, tube: number, segments = 64) => new THREE.TorusGeometry(radius, tube, 8, segments);
  const cylinder = (radius: number, length: number, segments = 48) => new THREE.CylinderGeometry(radius, radius, length, segments);

  if (preset === 'helmet') {
    add('Ceramic pressure shell', sphere(1, 72, 48, 0, Math.PI * 2, 0, 2.28), 'body', [0, .19, 0], [1.04, 1.16, .98]);
    add('Visor gasket', sphere(1, 64, 32, .43, Math.PI - .86, .62, 1.2), 'hardware', [0, .19, .025], [1.085, 1.195, 1.015]);
    add('Polarized glass', sphere(1, 64, 32, .53, Math.PI - 1.06, .69, 1.035), 'visor', [0, .19, .048], [1.087, 1.197, 1.025]);
    add('Armored chin', sphere(1, 64, 16, .38, Math.PI - .76, 1.79, .49), 'body', [0, .19, .045], [1.09, 1.16, 1.015]);
    add('Neck seal', ring(.69, .1), 'hardware', [0, -.71, -.02], [1, 1, 1], [Math.PI / 2, 0, 0]);
    add('Collar', cylinder(.68, .15), 'body', [0, -.85, -.02]);
    add('Collar lower seal', cylinder(.63, .075), 'hardware', [0, -.96, -.02]);
    add('Respirator housing', box(.58, .26, .15, .055), 'hardware', [0, -.58, .954], [1, 1, 1], [-.2, 0, 0]);
    add('Respirator cap', box(.42, .18, .055, .035), 'body', [0, -.57, 1.04], [1, 1, 1], [-.2, 0, 0]);
    for (let i = -2; i <= 2; i++) {
      add(`Breather slot ${i + 3}`, box(.022, .075, .012, .005), 'hardware', [i * .059, -.567, 1.075], [1, 1, 1], [-.2, 0, 0]);
    }
    add('Crown reinforcement', box(.25, .052, .62, .024), 'body', [0, 1.337, -.17], [1, 1, 1], [-.11, 0, 0]);
    add('Rear battery', box(.58, .52, .19, .075), 'hardware', [0, .15, -.973]);
    add('Battery cover', box(.43, .36, .07, .04), 'body', [0, .15, -1.089]);
    for (const side of [-1, 1]) {
      add(`${side} temple mount`, cylinder(.325, .17), 'hardware', [side * 1.025, .08, .01], [1, 1, 1], [0, 0, Math.PI / 2]);
      add(`${side} ear armor`, cylinder(.268, .075), 'body', [side * 1.135, .08, .01], [1, 1, 1], [0, 0, Math.PI / 2]);
      add(`${side} comms bezel`, ring(.19, .023, 40), 'hardware', [side * 1.181, .08, .01], [1, 1, 1], [0, Math.PI / 2, 0]);
      add(`${side} comms disc`, cylinder(.137, .013), 'hardware', [side * 1.184, .08, .01], [1, 1, 1], [0, 0, Math.PI / 2]);
      for (let n = 0; n < 6; n++) {
        const a = n * Math.PI / 3;
        add(`${side} captive screw ${n}`, cylinder(.025, .017, 6), 'hardware', [side * 1.185, .08 + Math.cos(a) * .228, .01 + Math.sin(a) * .228], [1, 1, 1], [0, 0, Math.PI / 2]);
      }
      add(`${side} lower latch`, box(.12, .19, .2, .025), 'hardware', [side * .82, -.5, .59], [1, 1, 1], [0, side * -.4, side * -.22]);
      add(`${side} latch cover`, box(.06, .11, .14, .015), 'body', [side * .89, -.49, .62], [1, 1, 1], [0, side * -.4, side * -.22]);
      for (let n = 0; n < 4; n++) {
        add(`${side} rear radiator ${n}`, box(.24, .025, .085, .01), 'hardware', [side * .68, .4 - n * .08, -.79], [1, 1, 1], [0, side * -.6, 0]);
      }
    }
  } else if (preset === 'sphere') {
    add('Shader ball', sphere(1, 80, 64), 'body', [0, .12, 0]);
    add('Inlaid equator', ring(1, .025), 'hardware', [0, .12, 0], [1, 1, 1], [Math.PI / 2.45, .2, .15]);
    add('Polished inset', sphere(1, 48, 24, .86, 1.4, .65, .9), 'visor', [0, .12, .01], [1.008, 1.008, 1.008]);
    add('Pedestal foot', cylinder(.7, .13), 'hardware', [0, -1.04, 0]);
    add('Pedestal top', cylinder(.56, .13), 'body', [0, -.93, 0]);
  } else {
    add('Beveled cube', box(1.75, 1.75, 1.75, .09), 'body', [0, 0, 0]);
    for (const side of [-1, 1]) {
      add(`Metal plate ${side}`, box(.075, .76, .76, .025), 'hardware', [side * .904, .05, 0]);
      add(`Inset ${side}`, box(.45, .45, .025, .03), 'visor', [0, .05, side * .89]);
    }
  }
  // Give the main shell most of its atlas and each remaining part its own padded UV tile.
  Object.values(pieces).forEach(meshes => {
    meshes.forEach((mesh, index) => {
      const uv = mesh.geometry.getAttribute('uv');
      let x = .015, y = .015, w = .97, h = .97;
      if (meshes.length > 1) {
        if (index === 0) { w = .63; }
        else {
          const count = meshes.length - 1, columns = Math.max(1, Math.ceil(Math.sqrt(count / 3)));
          const rows = Math.ceil(count / columns), slot = index - 1;
          w = .30 / columns; h = .97 / rows;
          x = .68 + (slot % columns) * w; y = .015 + Math.floor(slot / columns) * h;
          x += w * .04; y += h * .04; w *= .92; h *= .92;
        }
      }
      for (let i = 0; i < uv.count; i++) uv.setXY(i, x + uv.getX(i) * w, y + uv.getY(i) * h);
      uv.needsUpdate = true;
    });
  });
  return group;
}
