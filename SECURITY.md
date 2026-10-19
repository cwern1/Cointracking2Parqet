# Security

Cointracking2Parqet handles CoinTracking API secrets and Parqet access tokens in the browser. Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button on the Security tab of this repository. Do not open a public issue.

Particularly relevant:

- Anything that could send the CoinTracking API secret off the device.
- Ways to use the relay in `functions/` as an open proxy or to reach other hosts.
- Ways to read or misuse the Parqet token.
- Script injection into the page, which would bypass all of the above.
