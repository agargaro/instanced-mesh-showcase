import { Color, MeshLambertMaterial } from 'three';
import type { DataArrayTexture, Material, MeshStandardMaterial, WebGLProgramParametersWithUniforms } from 'three';
import {
  diffuseColor, float, materialColor, materialEmissive, mix, normalView, positionGeometry, positionViewDirection, smoothstep, texture, uv, vec3, vec4
} from 'three/tsl';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';

/** Fraction of the height of a monster that darkens toward its feet, and the light left at the feet. */
const OCCLUSION_HEIGHT = 0.4;
const FOOT_LIGHT = 0.5;
/**
 * Sky light on the edges facing away from the camera, tinted by the skin so the army colors stay: it separates the monsters from the
 * grass.
 */
const RIM_COLOR = new Color(0xd6e6ff).multiplyScalar(0.6);
const RIM_POWER = 4;

/**
 * A Lambert material for phones: base color from layer `layer` of the skins array texture, darkened toward the feet (occlusion by
 * height above the soles, `height` being the height of the model), a rim light and the glowing eyes of the exported emissive map; no
 * normal, roughness or environment maps. Classic WebGL: the stock material with `onBeforeCompile`; node renderers: a node material.
 */
export function createLambertSkinMaterial(base: MeshStandardMaterial, skins: DataArrayTexture, layer: number, height: number, backend: string): Material {
  const material = backend === 'webgl' ? new MeshLambertMaterial() : new MeshLambertNodeMaterial();
  material.emissive.copy(base.emissive);
  material.emissiveMap = base.emissiveMap;
  material.emissiveIntensity = base.emissiveIntensity;
  material.side = base.side;
  if (backend === 'webgl') {
    material.onBeforeCompile = createSkinCompile(skins, layer, height * OCCLUSION_HEIGHT);
  } else {
    const node = material as MeshLambertNodeMaterial & { emissiveNode: Node | null };
    node.colorNode = createSkinNode(skins, layer, height * OCCLUSION_HEIGHT);
    node.emissiveNode = vec3(materialEmissive).add(diffuseColor.rgb.mul(vec3(RIM_COLOR.r, RIM_COLOR.g, RIM_COLOR.b)).mul(float(1).sub(normalView.dot(positionViewDirection).saturate()).pow(RIM_POWER)));
  }
  return material;
}

function createSkinCompile(skins: DataArrayTexture, layer: number, occlusionHeight: number): (shader: WebGLProgramParametersWithUniforms) => void {
  return (shader) => {
    shader.uniforms['skinColors'] = { value: skins };
    shader.uniforms['skinLayer'] = { value: layer };
    shader.uniforms['occlusionHeight'] = { value: occlusionHeight };
    shader.uniforms['rimColor'] = { value: RIM_COLOR };
    shader.vertexShader = `varying vec2 vSkinUv;\nvarying float vSkinHeight;\n${shader.vertexShader
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvSkinUv = uv;\n\tvSkinHeight = position.y;')}`;
    shader.fragmentShader = `uniform highp sampler2DArray skinColors;\nuniform float skinLayer;\nuniform float occlusionHeight;\nuniform vec3 rimColor;\n`
      + `varying vec2 vSkinUv;\nvarying float vSkinHeight;\n${shader.fragmentShader
        .replace('#include <map_fragment>', 'diffuseColor *= texture( skinColors, vec3( vSkinUv, skinLayer ) );\n\t'
        + `diffuseColor.rgb *= mix( ${FOOT_LIGHT.toFixed(2)}, 1.0, smoothstep( 0.0, occlusionHeight, vSkinHeight ) );`)
        .replace('#include <opaque_fragment>', `outgoingLight += rimColor * diffuseColor.rgb * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), ${RIM_POWER.toFixed(1)} );\n\t`
        + '#include <opaque_fragment>')}`;
  };
}

function createSkinNode(skins: DataArrayTexture, layer: number, occlusionHeight: number) {
  const skin = texture(skins, uv()).depth(float(layer));
  const occlusion = mix(float(FOOT_LIGHT), float(1), smoothstep(float(0), float(occlusionHeight), positionGeometry.y));
  return vec4(skin.rgb.mul(materialColor).mul(occlusion), skin.a);
}
