import re

from prescan import build_pattern

pattern = re.compile(build_pattern(["AT", "ProductCard"]), re.IGNORECASE)

assert pattern.search("country === 'AT'")
assert pattern.search("<ProductCard")
assert not pattern.search("useReservations")
assert not pattern.search("isAtHome")
assert re.compile(build_pattern([])).search("anything") is None

print("ok")
