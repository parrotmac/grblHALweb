/*
  main.c - grblHAL wasm simulator entry point

  Part of grblHALweb

  grblHAL is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  grblHAL is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with grblHAL. If not, see <http://www.gnu.org/licenses/>.
*/

#include "sim.h"

#include "grbl/grbllib.h"

int main (void)
{
    sim_init();

    // Never returns: grblHAL's main loop yields to the host from sim_advance().
    return grbl_enter();
}
