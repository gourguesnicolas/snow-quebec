// Déclarations minimales de Leaflet (chargé via CDN dans index.html).
// Seulement ce que main.ts utilise : aucune dépendance npm n'est requise.
declare namespace L {
  type BoundsExpression = [[number, number], [number, number]];

  interface PathStyle {
    fill?: boolean;
    fillColor?: string;
    fillOpacity?: number;
    stroke?: boolean;
    color?: string;
    weight?: number;
    opacity?: number;
    interactive?: boolean;
  }

  interface Layer {
    addTo(target: Map | LayerGroup): this;
  }

  interface Path extends Layer {
    setStyle(style: PathStyle): this;
    bindTooltip(content: string | ((layer: Path) => string), options?: object): this;
  }

  interface Rectangle extends Path {}
  interface TileLayer extends Layer {}

  interface LayerGroup extends Layer {
    clearLayers(): this;
  }

  interface Control {
    addTo(map: Map): this;
  }

  interface Map {
    fitBounds(bounds: BoundsExpression, options?: object): this;
  }

  function map(element: string | HTMLElement, options?: object): Map;
  function tileLayer(urlTemplate: string, options?: object): TileLayer;
  function rectangle(bounds: BoundsExpression, options?: PathStyle): Rectangle;
  function layerGroup(): LayerGroup;
  function polygon(latlngs: [number, number][], options?: PathStyle): Path;

  namespace control {
    function zoom(options?: object): Control;
    function scale(options?: object): Control;
  }
}
