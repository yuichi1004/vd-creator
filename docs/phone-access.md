# Opening the review UI from a phone

`vd serve` listens on `127.0.0.1` by default, so only the PC that runs it can open the UI. This guide shows how to open it from your phone as well. For the design behind these choices, see [plan 0005](plans/0005-review-ui.md).

The examples use a project folder named `my-drama` and the default port, 5310. If you start `vd serve` with `--port <n>`, use that port everywhere instead of 5310. Run `npx vd` from the repository root, as described in the [scenario format guide](scenario-format.md).

## Recommended: Tailscale

[Tailscale](https://tailscale.com/) is a private network between your own devices, called a tailnet. It works at home and away, encrypts the traffic, and keeps the UI off your local network and off the internet. `vd serve` stays on `127.0.0.1`, and Tailscale forwards requests from your tailnet to it. vd does not call or configure Tailscale itself; you run the commands below.

### One-time setup

1. Install Tailscale on the PC and on the phone, and sign in to the same account on both. See [Install Tailscale](https://tailscale.com/kb/1347/installation). The phone uses the Tailscale app from the App Store or Google Play.
2. The first time you run `tailscale serve`, it may ask you to enable HTTPS certificates for your tailnet, and print a link to a consent page. Follow it. Before you agree, read [Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https): the PC's machine name and the tailnet's DNS name are published in the public Certificate Transparency log. Rename the machine first if its name says something you don't want public.

### Each time

1. On the PC, start the server:

   ```sh
   npx vd serve my-drama              # Listens on 127.0.0.1:5310
   ```

2. In another terminal on the PC, share the port with your tailnet:

   ```sh
   tailscale serve --bg 5310
   ```

   On Linux you may need `sudo` before `tailscale`. The command prints the URL, which looks like this:

   ```
   Available within your tailnet:
   https://my-pc.tailnet-name.ts.net/
   ```

3. On the phone, make sure Tailscale is connected, and open that URL in the browser. Tap play once to enable sound.

`--bg` keeps the share running in the background, also after a reboot or `tailscale down` and `tailscale up`, until you turn it off. It forwards to whatever listens on port 5310, so while `vd serve` is stopped the URL shows an error, and the next `vd serve` on the same port is reachable again.

### Stopping

Stop `vd serve` with Ctrl+C. To stop sharing the port, run the command that `tailscale serve --bg` printed when it started. For the command above, it is:

```sh
tailscale serve --https=443 off
```

To clear the PC's whole Serve configuration at once, run `tailscale serve reset`. Check what is still shared with `tailscale serve status`.

### Do not use Tailscale Funnel

Never use `tailscale funnel` for vd. Funnel publishes the port to the whole internet, and anyone who finds the URL can then edit your project and, with a paid provider, spend money. `tailscale serve` keeps it inside your tailnet. If you have used `tailscale funnel` on the same port before, the most recent command for a port decides whether it is public, so run `tailscale serve status` and make sure the port is not listed as Funnel.

Access within the tailnet follows your tailnet's access controls. If you share the PC with other people's tailnets, they can reach the UI too.

## Other VPNs and SSH tunnels

Anything that forwards requests from a trusted network to `127.0.0.1:5310` works the same way, with `vd serve` left on its default host:

- **An SSH tunnel.** From an SSH client on the phone, forward a local port to the PC, for example `ssh -L 5310:127.0.0.1:5310 user@pc-address`, then open `http://localhost:5310/` on the phone.
- **Another VPN with your own reverse proxy** on the PC, such as WireGuard with Caddy or nginx. The UI also works under a path prefix such as `/app/vd/`.

Without a token, the server accepts a request only if its `Host` header names an allowed host: `localhost`, `127.0.0.1`, `[::1]`, any name ending in `.ts.net`, or a name given with `--allow-host`, each with or without a port. Other requests get 403. This blocks DNS rebinding, where a hostile web page points its own name at your PC and then calls the API. So a reverse proxy must either rewrite `Host` to `127.0.0.1:5310`, or you name the host the phone uses:

```sh
npx vd serve my-drama --allow-host vd.home.example
```

Give the name only, without a port; the option can be repeated.

## Fallback: `--host`

If you cannot use a VPN, `vd serve --host <addr>` listens on that address directly, for example `0.0.0.0` for every address of the PC, or a VPN address of the PC such as `100.x.y.z`:

```sh
npx vd serve my-drama --host 0.0.0.0
```

It prints one URL for each address, with a random token, such as `http://192.168.x.y:5310/?token=...`, and a warning. Open the URL on the phone. On the first visit the server stores the token in a cookie and reloads the page without it. A request without the token gets 401. The Host allowlist above does not apply with `--host`, because the token check replaces it, so `--allow-host` is not needed.

Know the risks before you use it:

- **Anyone on the network who has the URL can edit the project** and, with a paid provider, spend money. A paid generation still asks for confirmation each time, but that does not stop someone who has the URL.
- **The token is in the URL.** It can end up in the phone's browser history, in screenshots, in a shared link, or in front of someone looking at your screen. Treat the URL as a password. A new token is made each time `vd serve` starts, so restart it if the URL leaks.
- **Traffic is plain HTTP.** vd adds no TLS. On a shared Wi-Fi, someone on the network can read the traffic, the token included. Only use `--host` on a network you trust, and stop the server when you are done.
- The PC's firewall may block the port; opening it also opens it to everyone else on that network.

Prefer Tailscale whenever you can.
