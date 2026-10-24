// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn web client: the owner's surface. Plain DOM, no innerHTML anywhere: capability output is
// untrusted and is only ever inserted as text. Screens follow the design handoffs (pass 1: A1–E3;
// pass 2: F–P, design/hewn/DESIGN-SYSTEM.md "Pass 2").
//
// One native ES module per section, in app/ (no bundler, no build step): the router imports the
// pages and starts the client.
import "./app/router.js";
