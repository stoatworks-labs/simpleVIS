//! Wire formats simpleVIS receives.
//!
//! Both parsers are pure functions over a byte slice with no I/O, so they are
//! unit-tested against synthetic packets built to the standards and can be
//! exercised without a network.

pub mod artnet;
pub mod sacn;
