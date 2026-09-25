cmake_minimum_required(VERSION 3.20)
project(grblhal-web C)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake: emcmake cmake -B build -G Ninja")
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

add_compile_options(-fno-strict-aliasing)

# grbl/vfs.h supplies its own time_t/struct tm unless it recognises the libc's
# <time.h> guard; musl's (_TIME_H) is not on its list.
add_compile_definitions(__time_t_defined)

# grblHAL core is built from a patched copy so the submodule stays pristine.
# patches/core holds fixes needed for wasm (strict indirect call signatures);
# they should go upstream and disappear from here over time.
set(GRBL_CORE_SRC ${CMAKE_SOURCE_DIR}/src/grbl)
set(GRBL_CORE_COPY ${CMAKE_BINARY_DIR}/core/grbl)
file(GLOB_RECURSE _core_files CONFIGURE_DEPENDS ${GRBL_CORE_SRC}/*.c ${GRBL_CORE_SRC}/*.h ${GRBL_CORE_SRC}/CMakeLists.txt)
file(GLOB _core_patches CONFIGURE_DEPENDS ${CMAKE_SOURCE_DIR}/patches/core/*.patch)
list(SORT _core_patches)

file(REMOVE_RECURSE ${GRBL_CORE_COPY})
file(COPY ${GRBL_CORE_SRC}/ DESTINATION ${GRBL_CORE_COPY} PATTERN ".git" EXCLUDE)
foreach(_patch ${_core_patches})
    execute_process(
        COMMAND patch -p1 --forward --silent -i ${_patch}
        WORKING_DIRECTORY ${GRBL_CORE_COPY}
        RESULT_VARIABLE _rc
    )
    if(NOT _rc EQUAL 0)
        message(FATAL_ERROR "Failed to apply ${_patch} to grblHAL core")
    endif()
endforeach()

include(${GRBL_CORE_COPY}/CMakeLists.txt)

# Firmware compiled once; linked twice below.
add_library(firmware OBJECT
    src/main.c
    src/sim.c
    src/driver.c
    src/mcu.c
    src/serial.c
)

target_compile_definitions(firmware PRIVATE F_CPU=16000000)
target_include_directories(firmware PRIVATE ${CMAKE_BINARY_DIR}/core src)
target_link_libraries(firmware PRIVATE grbl)

# grblHAL's main loop never returns, so it needs stack switching to hand
# control back to the browser. JSPI suspends the wasm stack natively (no
# overhead); Asyncify instruments the code instead and works in every engine.
# The host picks one at runtime (see web/src/firmware.js).
foreach(_async JSPI ASYNCIFY)
    string(TOLOWER ${_async} _name)
    set(_target grblhal-${_name})

    add_executable(${_target} $<TARGET_OBJECTS:firmware>)
    target_link_libraries(${_target} PRIVATE m)
    set_target_properties(${_target} PROPERTIES SUFFIX ".mjs")

    target_link_options(${_target} PRIVATE
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createGrblHAL
        -sENVIRONMENT=web,worker,node
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        # main() never returns; the host starts it with callMain() and does not await it
        -sINVOKE_RUN=0
        -sEXPORTED_RUNTIME_METHODS=callMain
        -s${_async}=1
    )

    # The npm package (pkg/) ships the builds from pkg/firmware.
    add_custom_command(TARGET ${_target} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_SOURCE_DIR}/pkg/firmware
        COMMAND ${CMAKE_COMMAND} -E copy
            $<TARGET_FILE:${_target}>
            $<TARGET_FILE_DIR:${_target}>/${_target}.wasm
            ${CMAKE_SOURCE_DIR}/pkg/firmware/
        VERBATIM
    )
endforeach()
