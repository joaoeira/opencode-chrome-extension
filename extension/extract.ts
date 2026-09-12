import Defuddle from "defuddle/full";

export function read() {
  const result = new Defuddle(document, { markdown: true, useAsync: false }).parse();

  return {
    title: document.title.slice(0, 1024),
    url: location.href,
    text: result.content,
  };
}
