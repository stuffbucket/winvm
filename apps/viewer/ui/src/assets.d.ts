// Pictures the bundler copies next to the page; the import is their URL.
declare module "*.jpg" {
  const url: string
  export default url
}
