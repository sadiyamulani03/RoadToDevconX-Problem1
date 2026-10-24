import { parseAbi, parseAbiItem, toEventSelector, type Hex } from 'viem';

export const ANNOUNCEMENT_EVENT = parseAbiItem(
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
);

export const ANNOUNCER_ABI = parseAbi([
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
  'function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)',
]);

export const ROUTER_ABI = parseAbi([
  'function pay(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata) payable',
  'function announcer() view returns (address)',
]);

export const ANNOUNCEMENT_TOPIC: Hex = toEventSelector(ANNOUNCEMENT_EVENT);
