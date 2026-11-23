export const go = (path: string) => {
  location.hash = path;
};
export const replace = (path: string) => {
  location.replace('#' + path);
};
export const back = () => history.back();
