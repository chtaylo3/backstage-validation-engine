/** @param {AsyncIterable<{ type: string, data: unknown }>} source */
export default async function* report(source) {
  for await (const event of source) {
    if (event.type === 'test:summary') yield JSON.stringify(event.data) + '\n';
  }
}
