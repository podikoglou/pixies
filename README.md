# pixies

What happens if you give an agent access to
[OpenStreetMap](https://www.openstreetmap.org)? Well, this project.

Pixies is an agent which can answer queries using data from OpenStreetMap and
display results in a map widget. It can answer complex queries such as "find
IKEAs which are close to a LIDL in stockholm" by converting them to [Overpass
QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) plus doing
additional filtering of its own.

OpenStreetMap Services it uses:

- [Nominatim](https://nominatim.org/)
- [Overpass](https://wiki.openstreetmap.org/wiki/Overpass)
- [Tile Server](https://tile.openstreetmap.org/)

## Hosting

Despite this being a very simple single container app, Docker is suggested.

See [docs/DOCKER.md](docs/DOCKER.md).

## Public Instance

I'm running a public instance, we'll see how this goes. [pixies.aleep.lol](https://pixies.aleep.lol)
