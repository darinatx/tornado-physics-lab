// Entry: the structure lab (?lab) or the full simulator.
if (new URLSearchParams(location.search).has("lab")) void import("./labMain");
else void import("./main");
