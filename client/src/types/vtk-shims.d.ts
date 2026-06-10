/**
 * Déclarations d'appoint pour les sous-modules @kitware/vtk.js dépourvus de
 * fichier `.d.ts` (le paquet n'en fournit pas pour ImageMarchingCubes en
 * 34.15.1). On type l'API réellement utilisée par l'export OBJ (marching cubes)
 * de façon minimale — le reste de l'objet reste `any`.
 */
declare module "@kitware/vtk.js/Filters/General/ImageMarchingCubes" {
  interface VtkImageMarchingCubes {
    setInputData(imageData: unknown): void;
    update(): void;
    getOutputData(): any;
  }
  const vtkImageMarchingCubes: {
    newInstance(initialValues?: {
      contourValue?: number;
      computeNormals?: boolean;
      mergePoints?: boolean;
    }): VtkImageMarchingCubes;
  };
  export default vtkImageMarchingCubes;
}
